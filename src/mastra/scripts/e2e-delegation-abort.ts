/**
 * E2E proof for signal composition across the delegation boundary (F3, G3-core).
 *
 * The gap: a timeout or cancel aborted the WAIT but not the WORK. `delegate-task`
 * had no way to learn its parent had been aborted, so the parent died while the
 * child kept running — burning tokens and still able to mutate n8n/Mongo with
 * nobody left to receive its result. The plan calls this out directly: "cancel DB
 * nie jest utożsamiany z actual stop".
 *
 * This proves the composed chain end to end:
 *   harness run  →  execution context  →  tool  →  child model call
 * by aborting the parent mid-flight and asserting the CHILD's own abort signal
 * fires. No network: the model is a scripted mock that never resolves on its own,
 * so the only thing that can end the call is a propagated abort.
 *
 * Run: npx tsx src/mastra/scripts/e2e-delegation-abort.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { getCurrentRunAbortSignal, runWithHarnessExecutionContext } =
  await import('../services/harness-execution-context.js');

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
}

console.log('e2e:delegation-abort');

check('outside a run there is no ambient signal to compose', () => {
  assert.equal(getCurrentRunAbortSignal(), undefined, 'no run ⇒ no signal');
});

await checkAsync('the run signal is visible to code executing inside the run', async () => {
  const controller = new AbortController();
  await runWithHarnessExecutionContext(
    { runId: 'run-1', agentId: 'metaAgent', abortSignal: controller.signal },
    async () => {
      const seen = getCurrentRunAbortSignal();
      assert.ok(seen, 'a tool inside the run must see the run signal');
      assert.equal(seen, controller.signal);
      assert.equal(seen!.aborted, false);
    },
  );
});

await checkAsync('aborting the parent aborts the child call, not just the wait', async () => {
  // The parent's controller — this is what the harness publishes on the context.
  const parent = new AbortController();

  // Stand-in for the child model call: it NEVER settles by itself, so if the
  // parent's abort does not reach it, this test can only time out.
  const childCall = (signal: AbortSignal) => new Promise<string>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

  await runWithHarnessExecutionContext(
    { runId: 'run-2', agentId: 'metaAgent', abortSignal: parent.signal },
    async () => {
      // This mirrors what delegate-task now does: take the ambient parent signal
      // and compose it with its own local timeout controller.
      const local = new AbortController();
      const parentSignal = getCurrentRunAbortSignal();
      assert.ok(parentSignal, 'delegation must find the parent signal');
      const composed = AbortSignal.any([local.signal, parentSignal!]);

      const inFlight = childCall(composed);
      // Parent is cancelled/times out while the child is still working.
      parent.abort(new Error('parent_cancelled'));

      await assert.rejects(inFlight, /aborted/, 'the child call must actually abort');
      assert.equal(composed.aborted, true, 'composed signal reflects the parent abort');
      assert.equal(local.signal.aborted, false, 'the local timeout never fired — the parent did');
    },
  );
});

await checkAsync('a local timeout still aborts the child when the parent is healthy', async () => {
  const parent = new AbortController();
  await runWithHarnessExecutionContext(
    { runId: 'run-3', agentId: 'metaAgent', abortSignal: parent.signal },
    async () => {
      const local = new AbortController();
      const composed = AbortSignal.any([local.signal, getCurrentRunAbortSignal()!]);
      const inFlight = new Promise<string>((_, reject) => {
        composed.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      local.abort(new Error('delegation_timeout'));
      await assert.rejects(inFlight, /aborted/);
      assert.equal(parent.signal.aborted, false, 'the parent is untouched by a child timeout');
    },
  );
});

check('the harness publishes its composed signal on the context', () => {
  const source = readFileSync(
    new URL('../services/generate-with-harness.ts', import.meta.url),
    'utf8',
  );
  // The controller must exist BEFORE the context is opened, otherwise the signal
  // cannot be published and tools stay blind to the parent's abort.
  const controllerAt = source.indexOf('const harnessAbort = new AbortController();');
  const contextAt = source.indexOf('return runWithHarnessExecutionContext(');
  assert.ok(controllerAt > 0 && contextAt > 0, 'both anchors must exist');
  assert.ok(controllerAt < contextAt, 'the abort controller must be created before the context');
  assert.match(source, /abortSignal: composedAbortSignal,/);
});

check('delegation composes the parent signal on every sync path', () => {
  const source = readFileSync(
    new URL('../tools/system/delegate-task.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /getCurrentRunAbortSignal/, 'delegation must read the ambient signal');
  // Three harness-backed sync delegations (coding, knowledge, automation) plus
  // the generic direct-generate path.
  const uses = source.match(/getCurrentRunAbortSignal\(\)/g) ?? [];
  assert.ok(uses.length >= 4, `expected the signal on every sync path, found ${uses.length}`);
  // Sync children must be bounded by the coordinated budget, never a flat constant.
  assert.match(source, /codingSyncBudget\.timeoutMs/);
  assert.match(source, /knowledgeSyncBudget\.timeoutMs/);
  assert.match(source, /automationBudget\.timeoutMs/);
  // A parent window too small for automation routes to async instead of starting
  // a sync call that provably cannot finish.
  assert.match(source, /\|\| !automationBudget\.viable/);
});

check('the pipeline profile can actually be cancelled (CAN-002)', () => {
  const gateway = readFileSync(
    new URL('../services/generate-pipeline-with-reflection.ts', import.meta.url),
    'utf8',
  );
  // The gateway must accept a signal and hand it to the model, otherwise a
  // cancelled pipeline keeps calling tools and mutating state.
  assert.match(gateway, /abortSignal\?: AbortSignal;/, 'pipeline must accept a signal');
  assert.match(gateway, /\.abortSignal = input\.abortSignal/, 'and forward it to generate');

  // K2 — the profile itself: pipeline agents declare maxSteps 150 with no clock,
  // so liveness is what bounds them. It must start only where prepareStep exists,
  // or a healthy run would look silent and be cut.
  assert.match(gateway, /startRunLiveness\(runId, \{/);
  assert.match(gateway, /touchRunLiveness\(runId\)/, 'steps must re-earn the idle window');
  assert.match(gateway, /clearRunBudget\(runId\)/, 'the budget must be released');
  // live-verify:f3-can002 finding: a real Mastra Agent does NOT reject its
  // generate() promise on abort — it resolves with finishReason 'tripwire' and
  // empty text (confirmed against real Ollama: the real HTTP call actually
  // stopped in ~60ms, well short of full generation, so the abort worked — it
  // just doesn't surface as a rejection). Without this check a cancelled
  // pipeline run would silently return SUCCESS with nothing to say instead of
  // telling its caller it was cancelled.
  assert.match(gateway, /finishReason === 'tripwire'/, 'a tripwire result must be detected');
  assert.match(gateway, /input\.abortSignal\?\.aborted/, 'only an ACTUAL abort may reinterpret a tripwire as cancellation');
  const startAt = gateway.indexOf('startRunLiveness(runId, {');
  const prepareAt = gateway.indexOf('generateOptions.prepareStep =');
  assert.ok(startAt > 0 && prepareAt > startAt, 'liveness must start alongside prepareStep');

  const delegation = readFileSync(
    new URL('../tools/system/delegate-task.ts', import.meta.url),
    'utf8',
  );
  // The delegation timeout must ABORT, not merely reject the caller's wait.
  assert.match(delegation, /controller\.abort\(new Error\('delegation_timeout'\)\)/);
  assert.match(delegation, /\(signal\) => generatePipelineWithReflection\(/, 'pipeline gets the composed signal');
});

check('the harness itself detects an external-abort tripwire, not only its own timeout (F3)', () => {
  const source = readFileSync(
    new URL('../services/generate-with-harness.ts', import.meta.url),
    'utf8',
  );
  // live-verify:f3-can002 finding: `withTimeout`/`withLivenessGuard` race the
  // real call against their OWN reject, so the harness's OWN deadline is safe —
  // but an EXTERNAL parent abort that fires first has no competing reject, and
  // the raw call resolves with a hollow tripwire instead. Every harness-based
  // sync delegation (coding/knowledge/automation) depends on this being caught.
  assert.match(source, /finishReason === 'tripwire'/, 'a tripwire result must be detected');
  assert.match(source, /composedAbortSignal\.aborted/, 'only an ACTUAL abort may reinterpret a tripwire as cancellation');
  assert.match(source, /throw reason instanceof Error/, 'the original abort reason must propagate as the rejection');
});

if (failures > 0) {
  console.error(`\n❌ e2e:delegation-abort — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ e2e:delegation-abort — parent abort stops the child, not just the wait');
process.exit(0);
