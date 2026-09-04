/**
 * E2E (deterministic) — Reflektor Part 2 §2.6: stopWhen → give up & escalate.
 *
 * Goal: prove that Mastra's REAL `agent.generate()` loop invokes our custom
 * `stopWhen` (a StopCondition `({ steps }) => boolean | Promise<boolean>`) and
 * HALTS the run early when the trajectory is unrecoverable — instead of burning
 * the rest of `maxSteps` to feign success.
 *
 * Mechanism: a scripted MockLanguageModelV3 keeps calling `flaky_tool`, whose
 * execute ALWAYS returns `{ success: false }`. The real StrategyReflector's
 * stateless `isUnrecoverable(steps)` fires once the sustained error rate clears
 * the threshold over enough calls, and the same stopWhen closure used in
 * production (mirrors generate-with-harness.ts) returns true. The run must end
 * BEFORE `maxSteps` — which only happens if Mastra honors stopWhen.
 *
 * Run: npx tsx src/mastra/scripts/e2e-reflector-stop-when.ts
 */
import assert from 'node:assert/strict';

process.env.FEATURE_REFLECTOR_STOP_WHEN = 'true';
process.env.DISABLE_REFLECTOR_TELEMETRY = '1';

const { Agent } = await import('@mastra/core/agent');
const { createTool } = await import('@mastra/core/tools');
const { z } = await import('zod');
const { MockLanguageModelV3 } = await import('ai/test');
const { stepCountIs } = await import('ai');
const { StrategyReflector } = await import('../services/strategy-reflector.js');
const { normalizeStepsForReflector } = await import('../services/generate-with-harness.js');
const normalizeSteps = normalizeStepsForReflector;

const FLAKY_TOOL = 'flaky_tool';
const MAX_STEPS = 20;

// ── A tool that always fails ──
const flakyTool = createTool({
  id: FLAKY_TOOL,
  description: 'A tool that always fails.',
  inputSchema: z.object({ n: z.number().optional() }),
  outputSchema: z.object({ success: z.boolean() }),
  execute: async () => ({ success: false }),
});

// ── Scripted mock model: keep calling flaky_tool forever ──
let modelStep = 0;
const model = new MockLanguageModelV3({
  modelId: 'mock-reflector-stopwhen-e2e',
  doGenerate: (async () => {
    modelStep += 1;
    return {
      content: [{
        type: 'tool-call' as const,
        toolCallId: `call-${modelStep}`,
        toolName: FLAKY_TOOL,
        input: JSON.stringify({ n: modelStep }),
      }],
      finishReason: 'tool-calls' as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      warnings: [],
    };
  }) as any,
});

// ── Real reflector + production-mirrored stopWhen closure ──
const runId = `e2e-reflector-stopwhen-${Date.now()}`;
const reflector = new StrategyReflector({
  runId,
  agentId: 'e2e-agent',
  originalPrompt: 'do the impossible task',
  config: { warmupSteps: 1, unrecoverableErrorRate: 0.8, unrecoverableMinToolCalls: 6 },
});

let stopWhenFired = false;
let stopWhenCalls = 0;
// Mirror the production harness: maxSteps and a custom stopWhen are mutually
// exclusive in Mastra (maxSteps → stepCountIs override), so we pass an OR-array
// of [stepCountIs(MAX_STEPS), predicate] and DO NOT pass maxSteps.
const unrecoverableStop = async (args: Record<string, unknown>) => {
  stopWhenCalls += 1;
  const rawSteps = Array.isArray(args.steps) ? args.steps as Array<Record<string, unknown>> : [];
  if (!reflector.isUnrecoverable(normalizeSteps(rawSteps))) return false;
  stopWhenFired = true;
  return true;
};

const agent = new Agent({
  id: 'e2e-reflector-stopwhen-agent',
  name: 'e2e-reflector-stopwhen-agent',
  instructions: 'You repeatedly call flaky_tool.',
  model: model as any,
  tools: { [FLAKY_TOOL]: flakyTool },
});

const originalWarn = console.warn;
console.warn = () => {};
let result: any;
try {
  result = await agent.generate('Please use the flaky_tool.', {
    stopWhen: [stepCountIs(MAX_STEPS), unrecoverableStop],
  } as any);
} finally {
  console.warn = originalWarn;
}

// ── Assertions ──
assert.ok(result, 'agent.generate must resolve a result (run did not crash)');
assert.ok(stopWhenFired, 'expected stopWhen to declare the trajectory unrecoverable');
// The run must have stopped BEFORE exhausting maxSteps.
assert.ok(modelStep < MAX_STEPS, `expected an early stop, but model was called ${modelStep}/${MAX_STEPS} times`);
// isUnrecoverable needs >= 6 failing calls, so the stop should come a few steps in (not at step 1).
assert.ok(modelStep >= 6, `expected the stop to require sustained failure (>=6 calls), got ${modelStep}`);

console.log('✅ E2E stopWhen: Mastra invoked stopWhen and halted the unrecoverable run early.');
console.log(`   • model calls before stop: ${modelStep} (maxSteps=${MAX_STEPS})`);
console.log(`   • stopWhen evaluations: ${stopWhenCalls}`);
console.log(`   • finishReason: ${result.finishReason}`);
