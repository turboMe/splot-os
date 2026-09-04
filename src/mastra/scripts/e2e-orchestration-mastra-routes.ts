#!/usr/bin/env tsx
/**
 * e2e:orchestration-mastra-routes — the flag-gated Mastra v2 route handlers.
 *
 * Exercises the Hono route handlers that index.ts mounts under
 * FEATURE_ORCHESTRATION_V2, against a real store via a mock Hono context — no
 * full Mastra server boot. Proves request/response mapping (202/200/401/404/409)
 * and that a command drives to COMPLETED once the lane/worker run.
 *
 * Needs a replica set: skips without one, or FAILS under REQUIRE_RS=1 (the gate
 * sets it). Throwaway DB, dropped on exit.
 */
import assert from 'node:assert/strict';
import {
  v2RouteDefs, configureV2Mount, __closeV2Store,
} from '../orchestration/http/mastra-routes.js';
import {
  connectV2Store, drainLane, drainWorkers, okWorker, drainConversation,
} from '../orchestration/store/index.js';
import { replicaSetUriOrSkip } from './lib/replica-set.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

interface Captured { status: number; body: Record<string, unknown> }
function mockC(opts: { params?: Record<string, string>; headers?: Record<string, string>; query?: Record<string, string>; body?: unknown }) {
  const captured: Captured = { status: 200, body: {} };
  return {
    captured,
    req: {
      param: (k: string) => opts.params?.[k],
      header: (k: string) => opts.headers?.[k],
      query: (k: string) => opts.query?.[k],
      json: async () => { if (opts.body === undefined) throw new Error('no body'); return opts.body; },
    },
    json: (b: Record<string, unknown>, s = 200) => { captured.body = b; captured.status = s; return captured; },
  };
}
const route = (path: string, method: string) => v2RouteDefs.find((d) => d.path === path && d.method === method)!;

async function call(path: string, method: string, opts: { params?: Record<string, string>; headers?: Record<string, string>; query?: Record<string, string>; body?: unknown }): Promise<Captured> {
  const c = mockC(opts);
  await route(path, method).handler(c as never);
  return c.captured;
}

async function main(): Promise<void> {
  console.log('e2e:orchestration-mastra-routes');
  const dbName = `orch_routes_e2e_${Date.now()}`;
  const resolved = await replicaSetUriOrSkip('e2e:orchestration-mastra-routes');
  if (!resolved) process.exit(0);
  const RS_URI: string = resolved;

  // Point the mount at the test store; no background loops (we drive manually).
  configureV2Mount({ uri: RS_URI, dbName, startBackground: false });
  const auth = { 'x-resource-id': 'res_1' };

  try {
    await check('unauthenticated → 401', async () => {
      const r = await call('/v2/conversations/:cid/commands', 'POST', { params: { cid: 'c1' }, headers: {}, body: { commandId: 'x' } });
      assert.equal(r.status, 401);
    });

    let jobId = '';
    await check('POST command → 202 + jobId', async () => {
      const r = await call('/v2/conversations/:cid/commands', 'POST', { params: { cid: 'c1' }, headers: auth, body: { commandId: 'route_a', goal: 'g', payload: { op: 'x' } } });
      assert.equal(r.status, 202);
      assert.ok(typeof r.body.jobId === 'string' && (r.body.jobId as string).startsWith('job_'));
      jobId = r.body.jobId as string;
    });

    await check('GET job → 200 ACCEPTED; wrong owner → 404', async () => {
      const ok = await call('/v2/jobs/:jid', 'GET', { params: { jid: jobId }, headers: auth });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.phase, 'ACCEPTED');
      const other = await call('/v2/jobs/:jid', 'GET', { params: { jid: jobId }, headers: { 'x-resource-id': 'res_OTHER' } });
      assert.equal(other.status, 404);
    });

    await check('same commandId different payload → 409', async () => {
      const r = await call('/v2/conversations/:cid/commands', 'POST', { params: { cid: 'c1' }, headers: auth, body: { commandId: 'route_a', goal: 'g', payload: { op: 'DIFFERENT' } } });
      assert.equal(r.status, 409);
    });

    await check('drive lane+worker → GET reports COMPLETED', async () => {
      const s = await connectV2Store({ uri: RS_URI, dbName });
      for (let i = 0; i < 10; i++) { await drainLane(s.client, s.db); await drainWorkers(s.client, s.db, okWorker); }
      await s.close();
      const r = await call('/v2/jobs/:jid', 'GET', { params: { jid: jobId }, headers: auth });
      assert.equal(r.body.phase, 'TERMINAL');
      assert.equal(r.body.terminalOutcome, 'COMPLETED');
    });

    await check('GET conversation projections → 200 ordered; owner-scoped; ?after cursor', async () => {
      const s = await connectV2Store({ uri: RS_URI, dbName });
      await drainConversation(s.client, s.db); // C boundary: terminal → projection
      await s.close();
      const r = await call('/v2/conversations/:cid/projections', 'GET', { params: { cid: 'c1' }, headers: auth });
      assert.equal(r.status, 200);
      const messages = r.body.messages as Array<{ sequence: number; jobId: string }>;
      assert.equal(messages.length, 1, 'the completed job is projected');
      assert.equal(messages[0]!.jobId, jobId);
      assert.equal(r.body.nextCursor, 1);
      // wrong owner → empty (no cross-resource disclosure)
      const other = await call('/v2/conversations/:cid/projections', 'GET', { params: { cid: 'c1' }, headers: { 'x-resource-id': 'res_OTHER' } });
      assert.equal((other.body.messages as unknown[]).length, 0);
      // ?after cursor past the last sequence → empty
      const tail = await call('/v2/conversations/:cid/projections', 'GET', { params: { cid: 'c1' }, headers: auth, query: { after: '1' } });
      assert.equal((tail.body.messages as unknown[]).length, 0);
    });

    await check('cancel via job command → 202 CANCELLED', async () => {
      const acc = await call('/v2/conversations/:cid/commands', 'POST', { params: { cid: 'c2' }, headers: auth, body: { commandId: 'route_cancel', goal: 'c', payload: {} } });
      const cid = acc.body.jobId as string;
      const r = await call('/v2/jobs/:jid/commands', 'POST', { params: { jid: cid }, headers: auth, body: { commandId: 'cx', type: 'cancel_job' } });
      assert.equal(r.status, 202);
      assert.equal(r.body.terminalOutcome, 'CANCELLED');
    });
  } finally {
    await __closeV2Store();
    const cleanup = await connectV2Store({ uri: RS_URI, dbName });
    await cleanup.db.dropDatabase().catch(() => {});
    await cleanup.close();
  }

  if (failures > 0) { console.error(`\n❌ e2e:orchestration-mastra-routes — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ e2e:orchestration-mastra-routes — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`e2e failed: ${(err as Error).message}`); process.exit(1); });
