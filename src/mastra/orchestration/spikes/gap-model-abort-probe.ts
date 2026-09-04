#!/usr/bin/env tsx
/**
 * GAP-MODEL-ABORT-01 — feasibility spike (plan §32, §15.2).
 *
 * Question: does an `AbortSignal` passed to the AI-SDK model call (the exact
 * layer Mastra's `agent.generate/stream` wraps — `createOpenAICompatible` +
 * `ai` streamText/generateText) actually STOP token generation, or does the
 * call keep running after abort? Baseline reported 298 surfaces with
 * `acceptsAbortSignal=false`, so this must be MEASURED, not assumed.
 *
 * The probe uses the same provider construction as `lib/ollama-gateway.ts`
 * against local Ollama, so it exercises the real transport, not a mock.
 *
 * Probes:
 *   CONTROL   — stream to completion, no abort (proves the model sustains a long
 *               stream, so an abort result is meaningful).
 *   STREAM    — abort mid-stream; measure chunks delivered AFTER abort and the
 *               abort→stop latency.
 *   GENERATE  — abort a non-streaming generate; measure whether the promise
 *               rejects promptly (~abortAfterMs) vs running to completion.
 *
 * Pass criteria (recorded in ADR 0005):
 *   - STREAM: chunksAfterAbort small/zero AND abortToStopMs bounded AND the
 *     iteration observes the abort (throws/ends) — the signal reaches transport.
 *   - GENERATE: rejects with an abort error at ~abortAfterMs, well under the
 *     control full-generation time.
 * A negative result forces process-isolated workers (GAP-WORKER-ISO-01).
 *
 * Note: for a LOCAL Ollama, closing the HTTP connection stops server-side
 * generation. For a remote/cloud provider, "provider stops billing/compute" is
 * a separate confirmation per capability (recorded as a follow-up).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { streamText, generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const MODEL = process.env.SPIKE_MODEL ?? 'gemma4:e4b';
const ABORT_AFTER_MS = Number(process.env.SPIKE_ABORT_AFTER_MS ?? 800);
const OVERALL_WATCHDOG_MS = Number(process.env.SPIKE_WATCHDOG_MS ?? 120_000);
const MAX_TOKENS = Number(process.env.SPIKE_MAX_TOKENS ?? 300);

// Same construction as lib/ollama-gateway.ts resolveLanguageModel().
const provider = createOpenAICompatible({ name: 'ollama', apiKey: 'ollama', baseURL: `${OLLAMA_BASE_URL}/v1` });
const model = provider.chatModel(MODEL);

const LONG_PROMPT =
  'Write a very long, detailed numbered list counting from 1 to 400. For each ' +
  'number, add a short sentence of commentary. Do not stop early; produce the ' +
  'entire list.';

function nowMs(): number { return performance.now(); }

/** Run a probe with an overall watchdog so a hung request cannot hang the spike. */
async function withWatchdog<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`watchdog: ${label} exceeded ${OVERALL_WATCHDOG_MS}ms`)), OVERALL_WATCHDOG_MS);
  });
  try {
    return await Promise.race([fn(), guard]);
  } finally {
    clearTimeout(timer!);
  }
}

interface StreamProbeResult {
  chunksBeforeAbort: number;
  chunksAfterAbort: number;
  abortToStopMs: number | null;
  observedAbort: boolean;
  errorName: string | null;
  totalMs: number;
}

/** Count token-bearing parts of fullStream (text-delta OR reasoning-delta), so
 * reasoning models — whose output arrives as reasoning-deltas, not text — are
 * measured correctly. */
function isTokenPart(part: { type: string }): boolean {
  return part.type === 'text-delta' || part.type === 'reasoning-delta';
}

async function controlStream(): Promise<{ chunks: number; totalMs: number }> {
  const t0 = nowMs();
  let chunks = 0;
  const result = streamText({ model, prompt: LONG_PROMPT, maxOutputTokens: MAX_TOKENS });
  for await (const part of result.fullStream) { if (isTokenPart(part)) chunks++; }
  return { chunks, totalMs: nowMs() - t0 };
}

async function streamAbortProbe(): Promise<StreamProbeResult> {
  const controller = new AbortController();
  const t0 = nowMs();
  let chunksBeforeAbort = 0;
  let chunksAfterAbort = 0;
  let aborted = false;
  let abortAt = 0;
  let abortToStopMs: number | null = null;
  let observedAbort = false;
  let errorName: string | null = null;

  // Fire the abort on a timer, mid-stream.
  const abortTimer = setTimeout(() => { aborted = true; abortAt = nowMs(); controller.abort(); }, ABORT_AFTER_MS);

  try {
    const result = streamText({ model, prompt: LONG_PROMPT, maxOutputTokens: MAX_TOKENS, abortSignal: controller.signal });
    for await (const part of result.fullStream) {
      // AI SDK may surface an abort as a stream part rather than a throw.
      if (part.type === 'error' || part.type === 'abort') {
        observedAbort = true;
        errorName = part.type === 'error' ? ((part as { error?: { name?: string } }).error?.name ?? 'error-part') : 'abort-part';
        break;
      }
      if (!isTokenPart(part)) continue;
      if (!aborted) chunksBeforeAbort++;
      else chunksAfterAbort++;
    }
  } catch (err) {
    observedAbort = true;
    errorName = (err as Error)?.name ?? 'Error';
  } finally {
    clearTimeout(abortTimer);
    if (aborted) abortToStopMs = nowMs() - abortAt;
  }

  return { chunksBeforeAbort, chunksAfterAbort, abortToStopMs, observedAbort, errorName, totalMs: nowMs() - t0 };
}

async function generateAbortProbe(): Promise<{ rejected: boolean; errorName: string | null; elapsedMs: number }> {
  const controller = new AbortController();
  const t0 = nowMs();
  setTimeout(() => controller.abort(), ABORT_AFTER_MS);
  try {
    await generateText({ model, prompt: LONG_PROMPT, maxOutputTokens: MAX_TOKENS, abortSignal: controller.signal });
    return { rejected: false, errorName: null, elapsedMs: nowMs() - t0 };
  } catch (err) {
    return { rejected: true, errorName: (err as Error)?.name ?? 'Error', elapsedMs: nowMs() - t0 };
  }
}

async function main(): Promise<void> {
  console.log(`GAP-MODEL-ABORT-01 spike — model=${MODEL} base=${OLLAMA_BASE_URL} abortAfter=${ABORT_AFTER_MS}ms`);

  const control = await withWatchdog('control', controlStream);
  console.log(`  CONTROL   chunks=${control.chunks} totalMs=${Math.round(control.totalMs)}`);

  const stream = await withWatchdog('stream-abort', streamAbortProbe);
  console.log(`  STREAM    beforeAbort=${stream.chunksBeforeAbort} afterAbort=${stream.chunksAfterAbort} ` +
    `abortToStopMs=${stream.abortToStopMs === null ? 'n/a' : Math.round(stream.abortToStopMs)} ` +
    `observedAbort=${stream.observedAbort} error=${stream.errorName} totalMs=${Math.round(stream.totalMs)}`);

  const gen = await withWatchdog('generate-abort', generateAbortProbe);
  console.log(`  GENERATE  rejected=${gen.rejected} error=${gen.errorName} elapsedMs=${Math.round(gen.elapsedMs)}`);

  // --- verdict -------------------------------------------------------------
  const streamStops = stream.observedAbort && stream.chunksAfterAbort <= Math.max(2, Math.ceil(stream.chunksBeforeAbort * 0.1)) &&
    (stream.abortToStopMs === null || stream.abortToStopMs < 3_000);
  const generateStops = gen.rejected && gen.elapsedMs < Math.max(5_000, control.totalMs * 0.75);
  const controlMeaningful = control.chunks > 10 && control.totalMs > ABORT_AFTER_MS * 1.5;

  const verdict = !controlMeaningful ? 'INCONCLUSIVE'
    : (streamStops && generateStops) ? 'ABORT_WORKS'
    : (streamStops || generateStops) ? 'PARTIAL'
    : 'ABORT_INEFFECTIVE';

  const evidence = {
    spike: 'GAP-MODEL-ABORT-01',
    at: new Date().toISOString(),
    env: { model: MODEL, base: OLLAMA_BASE_URL, abortAfterMs: ABORT_AFTER_MS,
      aiSdk: '6.x', openaiCompatible: '2.x', node: process.version },
    control, stream, generate: gen,
    criteria: { controlMeaningful, streamStops, generateStops },
    verdict,
    implication: verdict === 'ABORT_WORKS'
      ? 'In-flight abort reaches transport; cooperative cancel of the model call is viable. GAP-WORKER-ISO-01 can allow shared-process cooperative workers (still isolate non-cooperative/subprocess).'
      : 'Abort does NOT reliably stop the model call in-process; GAP-WORKER-ISO-01 must mandate a killable separate process for model/subprocess attempts.',
    note: 'Local Ollama: closing the HTTP connection stops server-side generation. Remote/cloud providers need a separate per-capability confirmation that provider compute/billing stops.',
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(here, '../../../../docs/adr/evidence/gap-model-abort-01');
  const outFile = resolve(outDir, `probe-${MODEL.replace(/[^a-z0-9]+/gi, '_')}-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify(evidence, null, 2));

  console.log(`\n  VERDICT: ${verdict}`);
  console.log(`  evidence: ${outFile}`);

  // The spike is a measurement, not a pass/fail gate — always exit 0 unless it
  // could not run at all.
  if (verdict === 'INCONCLUSIVE') {
    console.error('  ⚠ control run did not sustain a long enough stream; adjust SPIKE_MODEL/prompt and re-run');
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`GAP-MODEL-ABORT-01 spike failed: ${(err as Error).message}`);
  process.exit(1);
});
