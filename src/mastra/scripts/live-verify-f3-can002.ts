#!/usr/bin/env tsx
/**
 * LIVE verification for F3 signal composition and CAN-002 pipeline cancel.
 *
 * Everything proved so far (e2e:delegation-abort, check:pipeline-reflector) uses
 * a scripted mock model — it proves the WIRING composes correctly, but not that
 * a REAL model call actually stops. This script closes that gap: it drives a
 * real local Ollama model (same construction as lib/ollama-gateway.ts and the
 * GAP-MODEL-ABORT-01 spike) through the ACTUAL production code paths introduced
 * in F3/CAN-002, and measures real wall-clock behaviour.
 *
 * PROOF A — context signal propagation (F3):
 *   Publish a parent abort signal on the harness execution context (exactly
 *   what `generateWithHarness` does), read it back via `getCurrentRunAbortSignal`
 *   (exactly what `delegate-task` does), compose it with a local controller, and
 *   feed the composed signal into a REAL `generateText` call against Ollama.
 *   Abort the PARENT mid-generation and confirm the real HTTP call actually
 *   stops — not a mock promise settling.
 *
 * PROOF B — pipeline gateway forwards abort into real generation (CAN-002):
 *   Call the ACTUAL exported `generatePipelineWithReflection` (not a
 *   reimplementation) with a real Agent wired to Ollama, using a real pipeline
 *   agentKey so the liveness/reflector wiring is exercised too. Abort shortly
 *   after start and confirm the real call settles quickly instead of running to
 *   completion.
 *
 * Both probes use a long-generation prompt (same shape as the existing
 * GAP-MODEL-ABORT-01 spike, whose evidence already established this prompt
 * style runs long enough to abort meaningfully) and an overall watchdog so a
 * regression can only fail this script, never hang it.
 *
 *
 * PROOF C — the harness itself surfaces an external abort as cancellation:
 *   This is the load-bearing case for F3. `generateWithHarness` races the real
 *   call against its OWN internal timeout/liveness deadline, but an EXTERNAL
 *   abort (a cancelled parent, composed via `input.abortSignal`) that fires
 *   BEFORE that internal deadline has no competing reject — so whatever the
 *   raw call settles with is what the harness returns. Proof C sets the
 *   harness's own timeout far in the future and fires only the external
 *   signal, isolating exactly this path (used by every harness-based sync
 *   delegation: coding, knowledge, automation).
 *
 *
 * PROOF D — HRN-002: an ASYNC pipeline delegation runs a real model through
 *   the real pipeline gateway end to end (not the bare generic path). This
 *   drives `startAsyncDelegation` for a genuine pipeline agentKey with a real
 *   Ollama model and confirms the delegation record completes with real
 *   generated content — deterministic routing is proven in
 *   check:async-pipeline-routing; this proves the SAME path actually produces
 *   a real answer, not just that the right function got called.
 *
 * Run: npx tsx src/mastra/scripts/live-verify-f3-can002.ts
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Agent } from '@mastra/core/agent';

process.env.FEATURE_LIVENESS_BUDGET = 'true';

// PROOF D writes real (if short-lived) documents through startAsyncDelegation.
// Isolate to a throwaway database rather than touching the real dev DB, same
// pattern as check:async-pipeline-routing.
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const LIVE_VERIFY_DATABASE = `lv_${Date.now()}`;
{
  const uri = ORIGINAL_MONGODB_URI ?? 'mongodb://localhost:27017/agentforge?replicaSet=rs0';
  const queryStart = uri.indexOf('?');
  const base = queryStart === -1 ? uri : uri.slice(0, queryStart);
  const query = queryStart === -1 ? '' : uri.slice(queryStart);
  const authorityStart = base.indexOf('://') + 3;
  const databaseStart = base.indexOf('/', authorityStart);
  const authority = databaseStart === -1 ? base : base.slice(0, databaseStart);
  process.env.MONGODB_URI = `${authority}/${LIVE_VERIFY_DATABASE}${query}`;
}

const {
  getCurrentRunAbortSignal,
  runWithHarnessExecutionContext,
} = await import('../services/harness-execution-context.js');
const { generatePipelineWithReflection } = await import('../services/generate-pipeline-with-reflection.js');
const { generateWithHarness } = await import('../services/generate-with-harness.js');
const { _resetRunDeadlines } = await import('../services/run-budget.js');
const { startAsyncDelegation, getAsyncDelegation } = await import('../services/async-delegation.js');
const { closeDb, getDb } = await import('../lib/mongo.js');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const MODEL_ID = process.env.LIVE_VERIFY_MODEL ?? 'gemma4:e4b';
const ABORT_AFTER_MS = Number(process.env.LIVE_VERIFY_ABORT_AFTER_MS ?? 3_000);
const WATCHDOG_MS = Number(process.env.LIVE_VERIFY_WATCHDOG_MS ?? 120_000);

// Same shape as the GAP-MODEL-ABORT-01 spike's LONG_PROMPT: forces enough real
// generation that "settled quickly" cannot be confused with "would have
// finished quickly anyway".
const LONG_PROMPT =
  'Write a very long, detailed numbered list counting from 1 to 200. For each ' +
  'number, add a short sentence of commentary. Do not stop early; produce the ' +
  'entire list.';

const provider = createOpenAICompatible({ name: 'ollama', apiKey: 'ollama', baseURL: `${OLLAMA_BASE_URL}/v1` });
const model = provider.chatModel(MODEL_ID);

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  const startedAt = performance.now();
  try {
    await withWatchdog(fn);
    console.log(`  ✓ ${name} (${Math.round(performance.now() - startedAt)}ms)`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
}

function withWatchdog<T>(fn: () => Promise<T>): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`watchdog: exceeded ${WATCHDOG_MS}ms`)), WATCHDOG_MS);
    }),
  ]);
}

console.log('live-verify:f3-can002');
console.log(`  model=${MODEL_ID} abortAfterMs=${ABORT_AFTER_MS} (first call pays Ollama load latency)`);

// ── PROOF A — context-published parent signal stops a REAL model call ───────
await check('F3: aborting the parent context signal stops a real Ollama generation', async () => {
  const parent = new AbortController();
  const startedAt = performance.now();

  await runWithHarnessExecutionContext(
    { runId: 'live-verify-a', agentId: 'liveVerifyAgent', abortSignal: parent.signal },
    async () => {
      // Exactly the composition pattern delegate-task.ts uses: a local
      // controller (would be the delegation timeout) combined with the
      // ambient parent signal read from the execution context.
      const local = new AbortController();
      const parentSignal = getCurrentRunAbortSignal();
      assert.ok(parentSignal, 'parent signal must be published on the context');
      const composed = AbortSignal.any([local.signal, parentSignal]);

      const call = generateText({ model, prompt: LONG_PROMPT, abortSignal: composed });

      setTimeout(() => parent.abort(new Error('parent_cancelled')), ABORT_AFTER_MS);

      let rejected = false;
      let rejectionMessage = '';
      try {
        await call;
      } catch (error) {
        rejected = true;
        rejectionMessage = String((error as Error)?.message ?? error);
      }
      assert.equal(rejected, true, 'the real generation must reject, not complete');
      // Strongest possible evidence: the rejection carries the EXACT reason we
      // passed to controller.abort(), not a generic network error — proving
      // this specific abort is what ended the real HTTP call.
      assert.equal(
        rejectionMessage,
        'parent_cancelled',
        `expected the exact parent abort reason to propagate, got: ${rejectionMessage}`,
      );

      const elapsedMs = performance.now() - startedAt;
      // Generous ceiling: real abort should settle within a few seconds of the
      // signal firing, nowhere near the tens of seconds a 200-item list needs.
      assert.ok(
        elapsedMs < ABORT_AFTER_MS + 15_000,
        `expected settlement shortly after abort (~${ABORT_AFTER_MS}ms), took ${Math.round(elapsedMs)}ms — the real HTTP call likely kept running`,
      );
      assert.equal(local.signal.aborted, false, 'the local controller must be untouched — the PARENT caused this');
    },
  );
});

// ── PROOF B — the pipeline gateway forwards abort into a REAL generation ────
await check('CAN-002: a cancelled pipeline run stops a real Ollama generation', async () => {
  const agent = new Agent({
    id: 'live-verify-pipeline-agent',
    name: 'live-verify-pipeline-agent',
    instructions: 'Follow the user instruction exactly.',
    model: model as never,
  });

  const controller = new AbortController();
  const startedAt = performance.now();
  setTimeout(() => controller.abort(new Error('live_verify_cancel')), ABORT_AFTER_MS);

  let rejected = false;
  let rejectionMessage = '';
  try {
    // The REAL exported gateway — chefAgent is a genuine PIPELINE_PHASE_TOOLS
    // entry, so this also exercises the liveness/reflector wiring CAN-002 added,
    // not only the abort path.
    await generatePipelineWithReflection({
      agent,
      agentKey: 'chefAgent',
      agentId: 'live-verify-pipeline-agent',
      prompt: LONG_PROMPT,
      threadId: 'live-verify-thread',
      resourceId: 'live-verify-resource',
      abortSignal: controller.signal,
    });
  } catch (error) {
    rejected = true;
    rejectionMessage = String((error as Error)?.message ?? error);
  }
  assert.equal(rejected, true, 'a cancelled pipeline run must reject, not silently complete');
  // Same strongest-evidence check: the exact abort reason must propagate all
  // the way from the gateway's public abortSignal to the real HTTP rejection.
  assert.equal(
    rejectionMessage,
    'live_verify_cancel',
    `expected the exact gateway abort reason to propagate, got: ${rejectionMessage}`,
  );

  const elapsedMs = performance.now() - startedAt;
  assert.ok(
    elapsedMs < ABORT_AFTER_MS + 15_000,
    `expected the pipeline call to stop shortly after abort (~${ABORT_AFTER_MS}ms), took ${Math.round(elapsedMs)}ms`,
  );
  // Budget-leak cleanup on the abort path is already covered statically by
  // check:liveness-budget (asserts clearRunBudget(runId) runs in `finally`);
  // the internal runId is not exposed on the error path, so it cannot be
  // re-checked live here without changing the gateway's public contract.
});

// ── PROOF C — the harness surfaces an external parent abort as cancellation ──
await check('F3: an external parent abort makes generateWithHarness reject, not resolve hollow', async () => {
  const agent = new Agent({
    id: 'live-verify-harness-agent',
    name: 'live-verify-harness-agent',
    instructions: 'Follow the user instruction exactly.',
    model: model as never,
  });

  const parent = new AbortController();
  const startedAt = performance.now();
  setTimeout(() => parent.abort(new Error('live_verify_harness_parent_abort')), ABORT_AFTER_MS);

  let rejected = false;
  let rejectionMessage = '';
  try {
    // timeoutMs is deliberately far larger than ABORT_AFTER_MS: only the
    // EXTERNAL signal may end this call, isolating exactly the gap this proof
    // exists for. If the harness's own internal deadline caused the cut instead,
    // this would not prove anything about the external-abort path.
    await generateWithHarness({
      agent,
      agentId: 'live-verify-harness-agent',
      prompt: LONG_PROMPT,
      phase: 'chat',
      timeoutMs: 60_000,
      abortSignal: parent.signal,
    } as never);
  } catch (error) {
    rejected = true;
    rejectionMessage = String((error as Error)?.message ?? error);
  }
  assert.equal(
    rejected,
    true,
    'an externally-aborted harness call must reject — a hollow success here means ' +
    'every sync delegation (coding/knowledge/automation) would silently report the ' +
    'cancelled parent run as a successful, empty completion',
  );
  assert.equal(
    rejectionMessage,
    'live_verify_harness_parent_abort',
    `expected the exact parent abort reason to propagate, got: ${rejectionMessage}`,
  );
  const elapsedMs = performance.now() - startedAt;
  assert.ok(
    elapsedMs < ABORT_AFTER_MS + 15_000,
    `expected the harness call to stop shortly after the external abort (~${ABORT_AFTER_MS}ms), took ${Math.round(elapsedMs)}ms`,
  );
});

// ── PROOF D — HRN-002: real async pipeline delegation, end to end ──────────
await check('HRN-002: an async pipeline delegation produces a real answer through the pipeline gateway', async () => {
  const agent = new Agent({
    id: 'live-verify-async-pipeline-agent',
    name: 'live-verify-async-pipeline-agent',
    instructions: 'Answer the question in one short sentence.',
    model: model as never,
  });
  const { delegationId } = await startAsyncDelegation({
    agent,
    agentId: 'chefAgent',
    prompt: 'What is the capital of France? Answer in one short sentence.',
    callerThreadId: `live-verify-caller-${Date.now()}`,
    timeoutMs: 60_000,
  });
  const deadline = Date.now() + 60_000;
  let record: Awaited<ReturnType<typeof getAsyncDelegation>> = null;
  while (Date.now() < deadline) {
    record = await getAsyncDelegation(delegationId);
    if (record && record.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(record, 'delegation record must exist');
  assert.equal(record!.status, 'completed', `expected completed, got ${record!.status}: ${record!.error ?? ''}`);
  const preview = record!.resultPreview ?? record!.result ?? '';
  assert.ok(preview.length > 0, 'a real model call must produce non-empty content');
  assert.match(preview, /paris/i, `expected the real model to answer Paris, got: ${preview.slice(0, 200)}`);
});

_resetRunDeadlines();
delete process.env.FEATURE_LIVENESS_BUDGET;
try { const db = await getDb(); await db.dropDatabase(); } catch { /* best-effort */ }
await closeDb().catch(() => undefined);
if (ORIGINAL_MONGODB_URI === undefined) delete process.env.MONGODB_URI;
else process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;

if (failures > 0) {
  console.error(`\n❌ live-verify:f3-can002 — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ live-verify:f3-can002 — real Ollama generation actually stops on abort (context signal + pipeline gateway)');
process.exit(0);
