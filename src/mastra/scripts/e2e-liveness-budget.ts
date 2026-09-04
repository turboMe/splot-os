/**
 * E2E proof for liveness budgeting (ideas/liveness-budget-plan.md L5).
 *
 * The unit checks prove the registry's arithmetic. This proves the thing that
 * actually matters, through the REAL harness path with the flag ON:
 *
 *   1. A slow-but-working agent SURVIVES far past the legacy wall-clock,
 *      because every step re-earns its idle window. Under DEADLINE the exact
 *      same run is killed — and this asserts that difference directly, so the
 *      regression would be visible rather than theoretical.
 *   2. A SILENT agent is still cut, with reason IDLE_TIMEOUT.
 *
 * No network: a scripted MockLanguageModelV3 supplies the steps, and the delays
 * are real (small) so the guard's timers genuinely fire.
 *
 * Run: npx tsx src/mastra/scripts/e2e-liveness-budget.ts
 */
import assert from 'node:assert/strict';

const { Agent } = await import('@mastra/core/agent');
const { createTool } = await import('@mastra/core/tools');
const { z } = await import('zod');
const { MockLanguageModelV3 } = await import('ai/test');
const { generateWithHarness } = await import('../services/generate-with-harness.js');
const { _resetRunDeadlines } = await import('../services/run-budget.js');

const STEP_TOOL = 'slow_step_tool';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A tool whose work takes `stepDelayMs`. Each completed call is a liveness
 * event, so a chain of them is exactly the "slow but working" shape that a
 * fixed wall-clock punishes and liveness must not.
 */
function makeSlowTool(stepDelayMs: number) {
  return createTool({
    id: STEP_TOOL,
    description: 'Performs one slow unit of real work.',
    inputSchema: z.object({ n: z.number().optional() }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => {
      await sleep(stepDelayMs);
      return { ok: true };
    },
  });
}

function makeSteppingModel(totalSteps: number) {
  let step = 0;
  return new MockLanguageModelV3({
    modelId: 'mock-liveness-e2e',
    doGenerate: (async () => {
      step += 1;
      if (step <= totalSteps) {
        return {
          content: [{
            type: 'tool-call' as const,
            toolCallId: `call-${step}`,
            toolName: STEP_TOOL,
            input: JSON.stringify({ n: step }),
          }],
          finishReason: 'tool-calls' as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text' as const, text: 'All slow work completed.' }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        warnings: [],
      };
    }) as any,
  });
}

/** A model that never returns — the run emits no events at all. */
function makeSilentModel(): any {
  return new MockLanguageModelV3({
    modelId: 'mock-liveness-silent',
    doGenerate: (async () => {
      await sleep(60_000); // far beyond the idle window under test
      return {
        content: [{ type: 'text' as const, text: 'too late' }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    }) as any,
  });
}

function makeAgent(model: unknown, stepDelayMs: number) {
  return new Agent({
    id: 'e2e-liveness-agent',
    name: 'e2e-liveness-agent',
    instructions: 'Call slow_step_tool until told to stop.',
    model: model as any,
    tools: { [STEP_TOOL]: makeSlowTool(stepDelayMs) },
  });
}

const originalWarn = console.warn;
const quiet = <T>(fn: () => Promise<T>): Promise<T> => {
  console.warn = () => {};
  return fn().finally(() => { console.warn = originalWarn; });
};

// Small enough to keep the proof fast, large enough that the timers are real.
const STEP_DELAY_MS = 220;
const TOTAL_STEPS = 6;               // ≈1.3s of genuine work
const TIGHT_WALL_CLOCK_MS = 700;     // deliberately shorter than the work

// ── 1. DEADLINE: the same work IS killed by a fixed wall-clock ───────────────
_resetRunDeadlines();
delete process.env.FEATURE_LIVENESS_BUDGET;

let deadlineError: Error | undefined;
await quiet(async () => {
  try {
    await generateWithHarness({
      agent: makeAgent(makeSteppingModel(TOTAL_STEPS), STEP_DELAY_MS),
      agentId: 'e2e-liveness-agent',
      prompt: 'Do the slow work.',
      phase: 'chat',
      // Explicit budget ⇒ legacy DEADLINE semantics, and short enough that a
      // working agent cannot finish inside it.
      timeoutMs: TIGHT_WALL_CLOCK_MS,
    } as any);
  } catch (error) {
    deadlineError = error as Error;
  }
});
assert.ok(
  deadlineError,
  'baseline is invalid: the fixed wall-clock did NOT kill a run longer than itself',
);
assert.match(
  deadlineError.message,
  /timed out/i,
  `expected a wall-clock timeout, got: ${deadlineError.message}`,
);

// ── 2. LIVENESS: the identical work SURVIVES ────────────────────────────────
_resetRunDeadlines();
process.env.FEATURE_LIVENESS_BUDGET = 'true';

let livenessResult: any;
let livenessError: Error | undefined;
const startedAt = Date.now();
await quiet(async () => {
  try {
    livenessResult = await generateWithHarness({
      agent: makeAgent(makeSteppingModel(TOTAL_STEPS), STEP_DELAY_MS),
      agentId: 'e2e-liveness-agent',
      prompt: 'Do the slow work.',
      phase: 'chat',
      // No explicit timeoutMs ⇒ the profile's liveness envelope applies.
    } as any);
  } catch (error) {
    livenessError = error as Error;
  }
});
const elapsedMs = Date.now() - startedAt;

assert.ok(!livenessError, `working agent must not be cut, but got: ${livenessError?.message}`);
assert.ok(livenessResult, 'liveness run must produce a result');
assert.ok(
  elapsedMs > TIGHT_WALL_CLOCK_MS,
  `run must genuinely outlive the wall-clock that killed the baseline (${elapsedMs}ms ≤ ${TIGHT_WALL_CLOCK_MS}ms)`,
);

// ── 3. LIVENESS: a silent run is still cut, and says why ────────────────────
_resetRunDeadlines();
process.env.FEATURE_LIVENESS_BUDGET = 'true';
// Shrink the idle window via the same override operators use to calibrate, so
// the proof stays fast while exercising the identical mechanism.
process.env.LIVENESS_IDLE_TIMEOUT_MS = '1500';

let silentError: Error | undefined;
const silentStartedAt = Date.now();
await quiet(async () => {
  try {
    await generateWithHarness({
      agent: makeAgent(makeSilentModel(), STEP_DELAY_MS),
      agentId: 'e2e-liveness-agent',
      prompt: 'Never respond.',
      phase: 'chat',
    } as any);
  } catch (error) {
    silentError = error as Error;
  }
});

const silentElapsedMs = Date.now() - silentStartedAt;
assert.ok(silentError, 'a run that emits no event at all must still be cut');
assert.match(
  silentError.message,
  /idle|hard cap/i,
  `expected a liveness cut, got: ${silentError.message}`,
);
// The override must actually govern the cut — otherwise this would silently be
// testing the profile default and the calibration knob would be unproven.
assert.ok(
  silentElapsedMs < 15_000,
  `idle override did not take effect (waited ${silentElapsedMs}ms for a 1.5s window)`,
);

// Cleanup — never leak the flag into other suites.
delete process.env.FEATURE_LIVENESS_BUDGET;
delete process.env.LIVENESS_IDLE_TIMEOUT_MS;
_resetRunDeadlines();

console.log(JSON.stringify({
  schemaVersion: 'liveness-budget-e2e/v1',
  status: 'PASSED',
  baselineDeadline: {
    wallClockMs: TIGHT_WALL_CLOCK_MS,
    killedWorkingRun: true,
    error: deadlineError.message.slice(0, 120),
  },
  liveness: {
    steps: TOTAL_STEPS,
    stepDelayMs: STEP_DELAY_MS,
    elapsedMs,
    survivedWallClock: true,
  },
  silentRun: {
    cut: true,
    idleOverrideMs: 1500,
    elapsedMs: silentElapsedMs,
    reason: silentError.message.slice(0, 120),
  },
}));
console.log('✅ E2E liveness: a working agent outlives the wall-clock that kills it; silence is still cut.');
process.exit(0);
