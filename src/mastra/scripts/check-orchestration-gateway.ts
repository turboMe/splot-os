#!/usr/bin/env tsx
/**
 * check:orchestration-gateway — pure-unit coverage (no DB, no model) for the
 * Execution Gateway's bounded model call (plan §12/§10/§11). Runs in check:all.
 */
import assert from 'node:assert/strict';
import {
  createModelWorker,
  runBoundedModelCall,
  modelResultToProducer,
} from '../orchestration/execution/index.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.error(`  ✗ ${name}: ${(err as Error).message}`); }
}

async function main(): Promise<void> {
  console.log('check:orchestration-gateway');

  await check('cooperative caller returns text → ok', async () => {
    const r = await runBoundedModelCall({ deadlineAt: Date.now() + 5_000, prompt: 'p', callModel: async () => ({ text: '{"status":"ok"}' }) });
    assert.equal(r.ok, true);
    assert.equal(r.text, '{"status":"ok"}');
  });

  await check('a hanging non-cooperative caller does NOT hang the gateway (deadline race)', async () => {
    const start = Date.now();
    const r = await runBoundedModelCall({
      deadlineAt: Date.now() + 150, prompt: 'p',
      callModel: () => new Promise(() => { /* never resolves, ignores signal */ }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'deadline');
    assert.ok(Date.now() - start < 2_000, 'returned promptly at the deadline, did not hang');
  });

  await check('a cooperative caller that honors the signal → deadline', async () => {
    const r = await runBoundedModelCall({
      deadlineAt: Date.now() + 100, prompt: 'p',
      callModel: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted-by-signal')), { once: true });
      }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'deadline');
  });

  await check('parent signal pre-aborted → aborted', async () => {
    const parent = AbortSignal.abort();
    const r = await runBoundedModelCall({ deadlineAt: Date.now() + 5_000, prompt: 'p', parentSignal: parent, callModel: async () => ({ text: 'x' }) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'aborted');
  });

  await check('only an authoritative progress response re-arms the live deadline', async () => {
    const startedAt = Date.now();
    const r = await runBoundedModelCall({
      deadlineAt: startedAt + 120,
      prompt: 'p',
      reportProgress: async () => ({
        accepted: true,
        businessOperationCutoffAt: startedAt + 500,
        workDeadlineAt: startedAt + 502,
        hardDeadlineAt: startedAt + 504,
        absoluteHardDeadlineAt: startedAt + 900,
        extensionCount: 1,
      }),
      callModel: async ({ reportProgress }) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal((await reportProgress!({ fingerprint: 'hash-a', kind: 'snapshot' })).accepted, true);
        await new Promise((resolve) => setTimeout(resolve, 180));
        return { text: 'extended' };
      },
    });
    assert.equal(r.ok, true, 'the call should survive beyond its initial cutoff');
    assert.equal(r.progressExtensions, 1);
  });

  await check('a rejected milestone never extends the local timer', async () => {
    const startedAt = Date.now();
    const r = await runBoundedModelCall({
      deadlineAt: startedAt + 120,
      prompt: 'p',
      reportProgress: async () => ({
        accepted: false,
        reason: 'too_early',
        businessOperationCutoffAt: startedAt + 120,
        workDeadlineAt: startedAt + 122,
        hardDeadlineAt: startedAt + 124,
        absoluteHardDeadlineAt: startedAt + 900,
        extensionCount: 0,
      }),
      callModel: async ({ reportProgress, signal }) => {
        await reportProgress!({ fingerprint: 'hash-b', kind: 'snapshot' });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 300);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('cut'));
          }, { once: true });
        });
        return { text: 'must not finish' };
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'deadline');
  });

  await check('a live duplicate resynchronizes an extension whose first response was lost', async () => {
    const startedAt = Date.now();
    const r = await runBoundedModelCall({
      deadlineAt: startedAt + 80,
      workDeadlineAt: startedAt + 260,
      prompt: 'probe',
      reportProgress: async () => ({
        accepted: false,
        reason: 'duplicate',
        businessOperationCutoffAt: startedAt + 210,
        workDeadlineAt: startedAt + 230,
        hardDeadlineAt: startedAt + 250,
        absoluteHardDeadlineAt: startedAt + 400,
        extensionCount: 1,
      }),
      callModel: async ({ reportProgress }) => {
        await new Promise((resolve) => setTimeout(resolve, 35));
        await reportProgress?.({ kind: 'writer_snapshot_saved', fingerprint: 'same-hash' });
        await new Promise((resolve) => setTimeout(resolve, 85));
        return { text: 'resynchronized' };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.text, 'resynchronized');
    assert.equal(r.progressExtensions, 1);
  });

  await check('out-of-order progress replies cannot move a newer cutoff backwards', async () => {
    const startedAt = Date.now();
    const r = await runBoundedModelCall({
      deadlineAt: startedAt + 100,
      prompt: 'p',
      reportProgress: async (milestone) => {
        const older = milestone.fingerprint === 'older';
        await new Promise((resolve) => setTimeout(resolve, older ? 80 : 20));
        return {
          accepted: true,
          businessOperationCutoffAt: startedAt + (older ? 300 : 500),
          workDeadlineAt: startedAt + (older ? 302 : 502),
          hardDeadlineAt: startedAt + (older ? 304 : 504),
          absoluteHardDeadlineAt: startedAt + 900,
          extensionCount: older ? 1 : 2,
        };
      },
      callModel: async ({ reportProgress }) => {
        await Promise.all([
          reportProgress!({ fingerprint: 'older', kind: 'snapshot' }),
          reportProgress!({ fingerprint: 'newer', kind: 'snapshot' }),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 280));
        return { text: 'still alive' };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.progressExtensions, 2);
  });

  await check('provider error → error', async () => {
    const r = await runBoundedModelCall({ deadlineAt: Date.now() + 5_000, prompt: 'p', callModel: async () => { throw new Error('boom'); } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'error');
  });

  await check('harness hard-cap and idle-timeout errors map to deadline', async () => {
    for (const code of ['HARNESS_LIVENESS_HARD_CAP', 'HARNESS_LIVENESS_IDLE_TIMEOUT'] as const) {
      const error = Object.assign(new Error(`synthetic ${code}`), { code });
      const r = await runBoundedModelCall({
        deadlineAt: Date.now() + 5_000,
        prompt: 'p',
        callModel: async () => { throw error; },
      });
      assert.equal(r.ok, false, `${code} must not be reported as success`);
      assert.equal(r.reason, 'deadline', `${code} must use the timeout terminal path`);
    }
  });

  await check('model worker never invokes the provider inside the result-commit reserve', async () => {
    let calls = 0;
    const now = Date.now();
    const worker = createModelWorker({
      buildPrompt: () => 'p',
      callModel: async () => {
        calls++;
        return { text: '{"status":"ok","data":{}}' };
      },
    });
    const out = await worker({
      attemptId: 'attempt_expired_business',
      taskId: 'task_1',
      jobId: 'job_1',
      attemptNumber: 1,
      businessOperationCutoffAt: new Date(now - 1),
      workDeadlineAt: new Date(now + 3_000),
      hardDeadlineAt: new Date(now + 5_000),
      goal: 'g',
      instructions: [],
    }) as { status: string };
    assert.equal(out.status, 'timed_out');
    assert.equal(calls, 0);
  });

  await check('model worker aborts at business cutoff, before work/hard deadlines', async () => {
    let calls = 0;
    let abortedAt = 0;
    const start = Date.now();
    const businessCutoff = new Date(start + 150);
    const workDeadline = new Date(start + 3_000);
    const worker = createModelWorker({
      buildPrompt: () => 'p',
      callModel: ({ signal }) => {
        calls++;
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            abortedAt = Date.now();
            reject(new Error('business-cutoff'));
          }, { once: true });
        });
      },
    });
    const out = await worker({
      attemptId: 'attempt_business_cutoff',
      taskId: 'task_2',
      jobId: 'job_2',
      attemptNumber: 1,
      businessOperationCutoffAt: businessCutoff,
      workDeadlineAt: workDeadline,
      hardDeadlineAt: new Date(start + 5_000),
      goal: 'g',
      instructions: [],
    }) as { status: string };
    assert.equal(out.status, 'timed_out');
    assert.equal(calls, 1);
    assert.ok(abortedAt >= businessCutoff.getTime() - 25);
    assert.ok(abortedAt < workDeadline.getTime());
    assert.ok(Date.now() - start < 1_500);
  });

  await check('modelResultToProducer maps outcomes correctly (structured)', () => {
    assert.equal(modelResultToProducer({ ok: true, text: '{"status":"ok"}', durationMs: 1 }), '{"status":"ok"}');
    assert.equal((modelResultToProducer({ ok: false, reason: 'deadline', durationMs: 1 }) as { status: string }).status, 'timed_out');
    assert.equal((modelResultToProducer({ ok: false, reason: 'aborted', durationMs: 1 }) as { status: string }).status, 'cancelled');
    assert.equal((modelResultToProducer({ ok: false, reason: 'error', durationMs: 1 }) as { status: string }).status, 'failed');
  });

  await check('bounded_text mode wraps non-empty text as ok; empty is a failure (no false success)', () => {
    const ok = modelResultToProducer({ ok: true, text: '  Sunny, 21°C.  ', durationMs: 1 }, 'bounded_text') as { status: string; data: { text: string }; summary: string };
    assert.equal(ok.status, 'ok');
    assert.equal(ok.data.text, 'Sunny, 21°C.');
    assert.ok(ok.summary.length > 0);
    const empty = modelResultToProducer({ ok: true, text: '   ', durationMs: 1 }, 'bounded_text') as { status: string; error: { code: string } };
    assert.equal(empty.status, 'failed');
    assert.equal(empty.error.code, 'empty_output');
    // a deadline still maps to timed_out regardless of mode
    assert.equal((modelResultToProducer({ ok: false, reason: 'deadline', durationMs: 1 }, 'bounded_text') as { status: string }).status, 'timed_out');
  });

  if (failures > 0) { console.error(`\n❌ check:orchestration-gateway — ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ check:orchestration-gateway — all assertions passed');
  process.exit(0);
}

main().catch((err) => { console.error(`check failed: ${(err as Error).message}`); process.exit(1); });
