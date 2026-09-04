#!/usr/bin/env tsx
/**
 * GAP-WORKER-ISO-01 — feasibility spike (plan §32, §15.2, §16.1).
 *
 * Question: does a heavy attempt running inside the Front/dispatcher process
 * block the Node event loop (freezing control commands / status), and does
 * moving it to a separate execution context protect the loop? This sets the
 * process-isolation threshold: what MUST be isolated vs what may stay in-process.
 *
 * `GAP-MODEL-ABORT-01` already showed the *model call* is cooperatively
 * abortable. The open question here is the **event-loop** dimension, which is
 * orthogonal to cancellation.
 *
 * Method: a 25 ms heartbeat interval records how late each beat fires
 * (`actualGap − 25`) = event-loop lag. We measure max/observed lag while a fixed
 * workload runs under three conditions:
 *   SYNC_IN_PROCESS   — CPU-bound sync loop on the main thread (a heavy sync tool)
 *   SYNC_OUT_OF_PROC  — same loop in a worker_thread
 *   ASYNC_IN_PROCESS  — async-I/O loop that yields (like a streamed model call)
 *
 * Pass criteria → decision:
 *   SYNC_IN_PROCESS lag is large; SYNC_OUT_OF_PROC and ASYNC_IN_PROCESS lag are
 *   small ⇒ isolate CPU-bound/synchronous/non-cooperative attempts; async-I/O
 *   model calls may stay in-process (still cooperatively cancellable).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';

const WORKLOAD_MS = Number(process.env.SPIKE_WORKLOAD_MS ?? 1500);
const HEARTBEAT_MS = 25;

/** Records the worst event-loop stall observed while active. */
class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  maxLagMs = 0;
  missedBeats = 0;
  start(): void {
    this.maxLagMs = 0;
    this.missedBeats = 0;
    this.last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const lag = now - this.last - HEARTBEAT_MS;
      if (lag > this.maxLagMs) this.maxLagMs = lag;
      if (lag > HEARTBEAT_MS) this.missedBeats++;
      this.last = now;
    }, HEARTBEAT_MS);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

/** CPU-bound synchronous work: hash in a tight loop until durationMs elapses. */
function burnCpuSync(durationMs: number): number {
  const end = Date.now() + durationMs;
  let h = 'seed';
  let iters = 0;
  while (Date.now() < end) {
    h = createHash('sha256').update(h).digest('hex');
    iters++;
  }
  return iters;
}

const WORKER_SRC = `
  const { parentPort, workerData } = require('node:worker_threads');
  const { createHash } = require('node:crypto');
  const end = Date.now() + workerData.durationMs;
  let h = 'seed', iters = 0;
  while (Date.now() < end) { h = createHash('sha256').update(h).digest('hex'); iters++; }
  parentPort.postMessage({ iters });
`;

async function phaseSyncInProcess(hb: Heartbeat): Promise<number> {
  hb.start();
  // Give the heartbeat one clean beat before we block.
  await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 2));
  burnCpuSync(WORKLOAD_MS); // blocks the event loop
  await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 2));
  hb.stop();
  return hb.maxLagMs;
}

async function phaseSyncOutOfProcess(hb: Heartbeat): Promise<number> {
  hb.start();
  await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 2));
  await new Promise<void>((resolvePromise, reject) => {
    const w = new Worker(WORKER_SRC, { eval: true, workerData: { durationMs: WORKLOAD_MS } });
    w.once('message', () => { w.terminate().then(() => resolvePromise(), () => resolvePromise()); });
    w.once('error', reject);
  });
  await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 2));
  hb.stop();
  return hb.maxLagMs;
}

async function phaseAsyncInProcess(hb: Heartbeat): Promise<number> {
  hb.start();
  const end = Date.now() + WORKLOAD_MS;
  // Async-I/O-like loop: yields to the event loop every tick (as a streamed
  // model call does between tokens). Small sync work per tick is fine.
  while (Date.now() < end) {
    createHash('sha256').update('x').digest('hex'); // trivial per-tick work
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 2));
  hb.stop();
  return hb.maxLagMs;
}

async function main(): Promise<void> {
  console.log(`GAP-WORKER-ISO-01 spike — workload=${WORKLOAD_MS}ms heartbeat=${HEARTBEAT_MS}ms`);
  const hb = new Heartbeat();

  const syncIn = await phaseSyncInProcess(hb);
  console.log(`  SYNC_IN_PROCESS   maxLag=${Math.round(syncIn)}ms  (heavy sync tool on main thread)`);

  const syncOut = await phaseSyncOutOfProcess(hb);
  console.log(`  SYNC_OUT_OF_PROC  maxLag=${Math.round(syncOut)}ms  (same work in worker_thread)`);

  const asyncIn = await phaseAsyncInProcess(hb);
  console.log(`  ASYNC_IN_PROCESS  maxLag=${Math.round(asyncIn)}ms  (async-I/O loop, like a token stream)`);

  // --- verdict -------------------------------------------------------------
  const syncBlocks = syncIn > WORKLOAD_MS * 0.4;          // main thread frozen a long time
  const isolationProtects = syncOut < 60;                 // worker keeps loop responsive
  const asyncDoesNotBlock = asyncIn < 60;                 // async work keeps loop responsive
  const verdict = (syncBlocks && isolationProtects && asyncDoesNotBlock)
    ? 'ISOLATE_SYNC_KEEP_ASYNC'
    : (syncBlocks && !isolationProtects) ? 'ISOLATION_INEFFECTIVE'
    : 'INCONCLUSIVE';

  const evidence = {
    spike: 'GAP-WORKER-ISO-01',
    at: new Date().toISOString(),
    env: { node: process.version, workloadMs: WORKLOAD_MS, heartbeatMs: HEARTBEAT_MS },
    maxLagMs: { syncInProcess: Math.round(syncIn), syncOutOfProcess: Math.round(syncOut), asyncInProcess: Math.round(asyncIn) },
    criteria: { syncBlocks, isolationProtects, asyncDoesNotBlock },
    verdict,
    decision: verdict === 'ISOLATE_SYNC_KEEP_ASYNC'
      ? 'Isolate CPU-bound/synchronous/non-cooperative attempts in a separate execution context (worker_thread or child process). Async-I/O model calls may stay in-process and remain cooperatively cancellable (GAP-MODEL-ABORT-01). Front/dispatcher never runs a synchronous heavy attempt.'
      : 'Re-run: thresholds not met.',
    note: 'worker_thread demonstrates the event-loop protection cheaply; media/subprocess/browser attempts additionally need a killable OS process (child_process + TERM/grace/KILL) for GAP-MODEL-ABORT-style non-cooperative cancel.',
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(here, '../../../../docs/adr/evidence/gap-worker-iso-01');
  const outFile = resolve(outDir, `probe-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify(evidence, null, 2));
  console.log(`\n  VERDICT: ${verdict}`);
  console.log(`  evidence: ${outFile}`);

  process.exit(verdict === 'INCONCLUSIVE' ? 2 : 0);
}

main().catch((err) => { console.error(`GAP-WORKER-ISO-01 spike failed: ${(err as Error).message}`); process.exit(1); });
