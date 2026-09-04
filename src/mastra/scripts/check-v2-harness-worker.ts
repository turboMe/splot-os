#!/usr/bin/env tsx
/**
 * F5 — the V2 registry worker can run a routed agent under the FULL harness
 * profile instead of a bare `agent.generate`.
 *
 * WHY: `createMastraAgentCaller` calls `agent.generate(prompt, {abortSignal})`
 * directly. Correct for fixtures, but it silently drops every invariant the
 * harness owns — depth profile, Strategy Reflector, liveness budget,
 * pending-message consumption, tool envelopes. Migrating a real capability onto
 * V2 with that caller would REGRESS the protections CAN-002/HRN-002 just
 * verified on the legacy path. `createHarnessAgentCaller` closes the gap.
 *
 * The distinguishing signal is the option bag Mastra actually receives:
 * the harness installs `prepareStep` (reflector), `stopWhen` (step/limit
 * governance) and `memory`; a bare call carries only `abortSignal`. That is a
 * direct assertion that the levers are present, not a proxy for it.
 *
 * Runs against a REAL replica-set database (throwaway, dropped on exit) because
 * the harness writes telemetry/goal events; the model itself is a controllable
 * fake, so the check stays deterministic and fast.
 *
 * Run: npx tsx src/mastra/scripts/check-v2-harness-worker.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { countForbiddenWriterEmDashes } from '../tools/writer/anti-slop.js';
import { randomUUID } from 'node:crypto';
import type { WorkerContext } from '../orchestration/store/worker.js';

const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const TEST_DATABASE = `vhw_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

function withDatabaseName(uri: string, databaseName: string): string {
  const queryStart = uri.indexOf('?');
  const base = queryStart === -1 ? uri : uri.slice(0, queryStart);
  const query = queryStart === -1 ? '' : uri.slice(queryStart);
  const authorityStart = base.indexOf('://') + 3;
  if (authorityStart < 3) throw new Error('MONGODB_URI must include a scheme');
  const databaseStart = base.indexOf('/', authorityStart);
  const authority = databaseStart === -1 ? base : base.slice(0, databaseStart);
  return `${authority}/${databaseName}${query}`;
}

process.env.MONGODB_URI = withDatabaseName(
  ORIGINAL_MONGODB_URI ?? 'mongodb://localhost:27017/agentforge?replicaSet=rs0',
  TEST_DATABASE,
);

function restoreMongoUri(): void {
  if (ORIGINAL_MONGODB_URI === undefined) delete process.env.MONGODB_URI;
  else process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
}

const { createRegistryWorker, singleAgentRoute, harnessCallerFactory } =
  await import('../orchestration/execution/index.js');
const { closeDb, getDb } = await import('../lib/mongo.js');

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

interface RecordedCall { optionKeys: string[]; prompt: string; inputProcessorIds: string[] }

/**
 * Structural fake: the caller casts `RegistryAgent → Agent` anyway (the registry
 * hands back a real Agent in production), and the harness only needs `generate`.
 * A fake makes the option bag directly observable.
 */
function fakeAgent(opts: { text?: string; hangMs?: number } = {}) {
  const calls: RecordedCall[] = [];
  return {
    calls,
    agent: {
      async generate(prompt: string, options?: Record<string, unknown>) {
        const inputProcessors = Array.isArray(options?.inputProcessors) ? options.inputProcessors : [];
        calls.push({
          optionKeys: Object.keys(options ?? {}),
          prompt,
          inputProcessorIds: inputProcessors.map((processor) => String((processor as { id?: unknown }).id ?? '')),
        });
        if (opts.hangMs) {
          const signal = options?.abortSignal as AbortSignal | undefined;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, opts.hangMs);
            signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
          });
        }
        return { text: opts.text ?? 'ok' };
      },
    },
  };
}

function workerCtx(overrides: Partial<WorkerContext> & { cutoffMs?: number } = {}) {
  const now = Date.now();
  const cutoffMs = overrides.cutoffMs ?? 30_000;
  const { cutoffMs: _cutoffMs, ...contextOverrides } = overrides;
  return {
    attemptId: `att_${randomUUID()}`,
    taskId: `task_${randomUUID()}`,
    jobId: `job_${randomUUID()}`,
    attemptNumber: 1,
    businessOperationCutoffAt: new Date(now + cutoffMs),
    workDeadlineAt: new Date(now + cutoffMs + 5_000),
    hardDeadlineAt: new Date(now + cutoffMs + 10_000),
    goal: 'Say ok briefly.',
    instructions: [] as string[],
    ...contextOverrides,
  };
}

console.log('check:v2-harness-worker');

await check('baseline: the default (bare) caller carries NO governance levers', async () => {
  const { agent, calls } = fakeAgent();
  const worker = createRegistryWorker({
    getAgent: () => agent as never,
    route: singleAgentRoute('probeAgent'),
  });
  const out = await worker(workerCtx() as never);
  assert.equal(calls.length, 1, 'the agent must have been called exactly once');
  const keys = calls[0]!.optionKeys;
  assert.ok(keys.includes('abortSignal'), 'the gateway signal is always forwarded');
  assert.ok(!keys.includes('prepareStep'), `bare path must NOT have a reflector, got: ${keys.join(',')}`);
  assert.ok(!keys.includes('stopWhen'), `bare path must NOT have step governance, got: ${keys.join(',')}`);
  assert.equal((out as { status?: string }).status, 'ok', 'a normal bare run still succeeds');
});

await check('harness caller installs reflector + step governance + memory on the real option bag', async () => {
  const { agent, calls } = fakeAgent();
  const worker = createRegistryWorker({
    getAgent: () => agent as never,
    route: singleAgentRoute('probeAgent'),
    makeCaller: harnessCallerFactory,
  });
  const out = await worker(workerCtx() as never);
  assert.equal(calls.length, 1, 'the agent must have been called exactly once');
  const keys = calls[0]!.optionKeys;
  assert.ok(keys.includes('abortSignal'), 'the gateway signal must still reach the model');
  assert.ok(
    keys.includes('inputProcessors'),
    `real tool-execute abort fence missing; got: ${keys.join(',')}`,
  );
  assert.ok(
    calls[0]!.inputProcessorIds.includes('harness-abort-tool-fence'),
    'the harness must install the concrete abort-fence processor, not only an option with that name',
  );
  assert.ok(keys.includes('prepareStep'), `reflector lever missing — harness profile did not engage; got: ${keys.join(',')}`);
  assert.ok(keys.includes('stopWhen'), `step governance missing; got: ${keys.join(',')}`);
  assert.ok(keys.includes('memory'), `memory thread missing; got: ${keys.join(',')}`);
  // LIVE REGRESSION: the V2 memory resource must NOT be per-agent. A specialist
  // may delegate inside its own run (chefAgent's recon reaches the researcher),
  // and a per-agent resource made the inner agent's memory processor reject the
  // outer agent's messages — three empty attempts and a FAILED job.
  const { V2_MEMORY_RESOURCE } = await import('../orchestration/execution/harness-agent-caller.js');
  assert.ok(
    !V2_MEMORY_RESOURCE.includes(':'),
    `the lane resource must be one value for every agent, got ${V2_MEMORY_RESOURCE}`,
  );
  assert.equal((out as { status?: string }).status, 'ok', 'the harness path still produces a valid producer envelope');
});

await check('the full job brief reaches the model without replacing the task focus', async () => {
  const { agent, calls } = fakeAgent();
  const worker = createRegistryWorker({
    getAgent: () => agent as never,
    route: singleAgentRoute('probeAgent'),
    makeCaller: harnessCallerFactory,
  });
  await worker(workerCtx({
    goal: 'Draft the final confrontation.',
    taskGoal: 'Draft the final confrontation.',
    jobGoal: 'Write a complete five-chapter story about memory and responsibility.',
  }) as never);
  const prompt = calls[0]?.prompt ?? '';
  assert.match(prompt, /Write a complete five-chapter story about memory and responsibility\./);
  // This asserted the label `Current durable task focus`, which W3 (bb8c712)
  // deleted from the renderer without updating the gate — so it had been failing
  // on a string that exists nowhere in the repository, which is a gate measuring
  // its own memory rather than the code. It now asserts the PROPERTY it was
  // named after: both briefs present, neither replacing the other.
  assert.match(prompt, /Draft the final confrontation\./);
  assert.ok(
    prompt.indexOf('Write a complete five-chapter story') < prompt.indexOf('Draft the final confrontation'),
    'on a single-task job the JOB goal leads and the task focus refines it — the reverse '
    + 'demoted the user\'s own words to background and dropped whatever the refinement omitted',
  );
});

await check('the harness result is NOT truncated to the 1000-char outputPreview', async () => {
  // Regression lock: `HarnessGenerateResult.outputPreview` is truncated to 1000
  // chars. Using it as the job result would corrupt any structured envelope
  // larger than that — the A boundary would reject valid JSON as invalid_result.
  const long = 'x'.repeat(2_500);
  const { agent } = fakeAgent({ text: long });
  const worker = createRegistryWorker({
    getAgent: () => agent as never,
    route: singleAgentRoute('probeAgent'),
    makeCaller: harnessCallerFactory,
  });
  const out = await worker(workerCtx() as never) as { status?: string; data?: { text?: string } };
  assert.equal(out.status, 'ok');
  const text = out.data?.text ?? '';
  assert.equal(text.length, long.length, `expected the full ${long.length} chars through, got ${text.length} (truncation regression)`);
});

await check('Writer final text is normalized at the boundary, not thrown away', async () => {
  // POLICY CHANGED 2026-08-11, from measurement rather than preference.
  //
  // This used to require `status: 'failed'` — fail closed on U+2014, on the
  // reasoning that punctuation is Writer's own product quality. The seven-agent
  // sieve run priced that: a 150-word story came back with ONE em-dash, the
  // attempt failed, the retry failed identically, and the job ended FAILED with
  // nothing delivered. The ban was already in Writer's prompts three times and in
  // the global house style, so asking again had been exhausted — and a failed
  // attempt is RETRIED, so the model regenerates a whole manuscript over one
  // character.
  //
  // Failing closed protects the punctuation and destroys the work. The boundary
  // still guarantees no em-dash leaves the system; the anti-slop audit still
  // scores the text. What is no longer true is that a dash costs the deliverable.
  const { agent } = fakeAgent({ text: 'A sentence — followed by another.' });
  const worker = createRegistryWorker({
    getAgent: () => agent as never,
    route: singleAgentRoute('writerAgent'),
    makeCaller: harnessCallerFactory,
  });
  const out = await worker(workerCtx() as never) as { status?: string; data?: { text?: string } };
  assert.equal(out.status, 'ok', 'the story must survive a punctuation slip');
  const text = out.data?.text ?? '';
  assert.equal(countForbiddenWriterEmDashes(text), 0, 'and no em-dash may leave the boundary');
  assert.match(text, /A sentence - followed by another\./, 'the sentence itself must be intact');
});

await check('the gateway deadline still bounds a hanging model under the harness profile', async () => {
  // The harness gets `remaining - reserve`, so its own bound sits strictly inside
  // the gateway window (the K3/K4 rule). Either bound firing is acceptable; what
  // must NOT happen is hanging past the parent window or reporting false success.
  const { agent } = fakeAgent({ hangMs: 60_000 });
  const worker = createRegistryWorker({
    getAgent: () => agent as never,
    route: singleAgentRoute('probeAgent'),
    makeCaller: harnessCallerFactory,
  });
  const startedAt = Date.now();
  const out = await worker(workerCtx({ cutoffMs: 1_500 }) as never) as { status?: string };
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 20_000, `must not hang past its window, took ${elapsedMs}ms`);
  assert.ok(
    out.status === 'timed_out' || out.status === 'cancelled' || out.status === 'failed',
    `a cut run must report a non-success terminal, got ${out.status}`,
  );
  assert.notEqual(out.status, 'ok', 'a cut run must never be reported as success');
});

await check('the real Mastra dispatch path has a positive and negative abort-fence control', async () => {
  const { Agent } = await import('@mastra/core/agent');
  const { createTool } = await import('@mastra/core/tools');
  const { MockLanguageModelV3 } = await import('ai/test');
  const { z } = await import('zod');
  const { createHarnessAbortToolFenceProcessor } = await import('../services/harness-abort-tool-fence.js');

  async function runDispatch(useFence: boolean): Promise<{ sideEffectHappened: boolean }> {
    let sideEffectHappened = false;
    let modelCalls = 0;
    let announceModelStart!: () => void;
    let releaseModel!: () => void;
    const modelStarted = new Promise<void>((resolve) => { announceModelStart = resolve; });
    const modelRelease = new Promise<void>((resolve) => { releaseModel = resolve; });
    const fenceAbort = new AbortController();

    const model = new MockLanguageModelV3({
      modelId: `mock-dispatch-${useFence ? 'fenced' : 'control'}`,
      doGenerate: (async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          announceModelStart();
          await modelRelease;
          return {
            content: [{
              type: 'tool-call' as const,
              toolCallId: `late-${useFence}-${Date.now()}`,
              toolName: 'synthetic_write',
              input: JSON.stringify({ content: 'sentinel' }),
            }],
            finishReason: 'tool-calls' as const,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          };
        }
        return {
          content: [{ type: 'text' as const, text: 'done' }],
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      }) as any,
    });
    const syntheticWrite = createTool({
      id: 'synthetic_write',
      description: 'Sentinel side effect.',
      inputSchema: z.object({ content: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => {
        sideEffectHappened = true;
        return { ok: true };
      },
    });
    const agent = new Agent({
      id: `dispatch-${useFence ? 'fenced' : 'control'}-agent`,
      name: `dispatch-${useFence ? 'fenced' : 'control'}-agent`,
      instructions: 'Use the sentinel tool.',
      model: model as any,
      tools: { syntheticWrite },
    });
    const generate = agent.generate('Run the sentinel.', {
      maxSteps: 2,
      ...(useFence
        ? { inputProcessors: [createHarnessAbortToolFenceProcessor(fenceAbort.signal)] }
        : {}),
    } as any);
    await modelStarted;
    fenceAbort.abort(new Error('test_authority_lost'));
    releaseModel();
    await generate.catch(() => undefined);
    return { sideEffectHappened };
  }

  const control = await runDispatch(false);
  assert.equal(control.sideEffectHappened, true, 'negative control must execute the real tool without a fence');
  const fenced = await runDispatch(true);
  assert.equal(fenced.sideEffectHappened, false, 'the same real dispatch must be blocked by the abort fence');
});

try {
  const db = await getDb();
  await db.dropDatabase();
} catch {
  // best-effort cleanup; never mask a real assertion failure with a teardown error
}
await closeDb().catch(() => undefined);
restoreMongoUri();


// ── Supervision must REACH V2, not merely exist (group L) ────────────────────
await check('a V2 run is scored against a goal contract, not left unjudged', async () => {
  // L1. The scorer drives Mastra's `isTaskComplete` loop: a score of 0 injects
  // feedback and re-iterates. It is gated on `input.goalContractId`, so a caller
  // that supplies none turns the whole judgement off silently — the run would
  // finish on the step budget alone and nobody would say the goal was never
  // checked.
  //
  // The harness mints its own contract when the caller has none
  // (`harnessGoalContract?.contractId ?? input.goalContractId`), which is what
  // makes this reachable from V2 — measured live: 25 `output_score` events from
  // the review canaries, each naming a real contract id.
  const src = readFileSync('src/mastra/services/generate-with-harness.ts', 'utf-8');
  const at = src.indexOf('generateOptions.isTaskComplete = {');
  assert.ok(at > 0, 'output scoring must be wired at all');
  const guard = src.slice(Math.max(0, at - 500), at);
  assert.match(guard, /input\.goalContractId/,
    'scoring is gated on a contract id');
  assert.match(src, /let effectiveGoalContractId = harnessGoalContract\?\.contractId \?\? input\.goalContractId/,
    'and the harness must MINT one when the caller has none — otherwise every V2 job '
    + 'runs unjudged, because V2 passes no contract');
});

await check('every tool call records its risk class and the policy decision', async () => {
  // L3. Without these the telemetry says what ran but not whether it was allowed,
  // which is the half an operator actually needs after an incident.
  const src = readFileSync('src/mastra/services/harness-tool-envelope.ts', 'utf-8');
  for (const field of ['category', 'risk', 'policyDecision']) {
    assert.ok(src.includes(field),
      `${field} must be part of what a tool execution records`);
  }
  // And the decision has to carry WHY, not just a boolean.
  assert.match(src, /matchedRule|reason/,
    'a policy decision without its rule or reason cannot be audited');
});

if (failures > 0) {
  console.error(`\n❌ check:v2-harness-worker — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:v2-harness-worker — a V2 job can run under the same harness profile as a legacy delegation');
process.exit(0);
