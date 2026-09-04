/**
 * E2E (deterministic) — Reflektor Part 1: in-flight prepareStep actuator.
 *
 * Goal: prove that Mastra's REAL `agent.generate()` loop invokes our
 * `prepareStep` BEFORE each step and HONORS the returned `activeTools`
 * override — i.e. the in-flight tool_loop intervention actually removes the
 * looping tool from the next step's action space.
 *
 * Mechanism: a scripted MockLanguageModelV3 keeps calling `loop_tool` for as
 * long as that tool is offered to it. The real StrategyReflector + the same
 * prepareStep closure used in production (mirrors generate-with-harness.ts)
 * detect the tool_loop after `maxToolRepetitions` and drop `loop_tool` from
 * `activeTools`. Once Mastra stops offering `loop_tool`, the mock emits a final
 * answer and the run terminates — which only happens if the override took hold.
 *
 * Run: npx tsx src/mastra/scripts/e2e-reflector-prepare-step.ts
 */
import assert from 'node:assert/strict';

process.env.FEATURE_REFLECTOR_PREPARE_STEP = 'true';
process.env.DISABLE_REFLECTOR_TELEMETRY = '1';

const { Agent } = await import('@mastra/core/agent');
const { createTool } = await import('@mastra/core/tools');
const { z } = await import('zod');
const { MockLanguageModelV3 } = await import('ai/test');
const { StrategyReflector } = await import('../services/strategy-reflector.js');

const LOOP_TOOL = 'loop_tool';
const ESCAPE_TOOL = 'escape_tool';
const MAX_TOOL_REPETITIONS = 3;
const INTERVENTION_COOLDOWN_STEPS = 2;

// ── Mirror of the PRODUCTION normalizeSteps (generate-with-harness.ts) ──
// Imported from the harness so the E2E exercises the real extractor.
const { normalizeStepsForReflector } = await import('../services/generate-with-harness.js');
const normalizeSteps = normalizeStepsForReflector;

// ── The looping tools ──
const loopTool = createTool({
  id: LOOP_TOOL,
  description: 'A tool the model gets stuck repeating.',
  inputSchema: z.object({ n: z.number().optional() }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

const escapeTool = createTool({
  id: ESCAPE_TOOL,
  description: 'An alternative tool that remains available.',
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

const toolUniverse = [LOOP_TOOL, ESCAPE_TOOL];

// ── Scripted mock model: loop loop_tool while offered; otherwise finish ──
let modelStep = 0;
const offeredToolNamesPerCall: string[][] = [];
const model = new MockLanguageModelV3({
  modelId: 'mock-reflector-e2e',
  doGenerate: (async (options: any) => {
    const offered: string[] = Array.isArray(options.tools)
      ? options.tools.map((t: any) => t.name).filter(Boolean)
      : [];
    offeredToolNamesPerCall.push(offered);
    const loopStillOffered = offered.includes(LOOP_TOOL);
    const forcedNoTool = options.toolChoice?.type === 'none';
    modelStep += 1;

    if (loopStillOffered && !forcedNoTool && modelStep <= 12) {
      return {
        content: [{
          type: 'tool-call' as const,
          toolCallId: `call-${modelStep}`,
          toolName: LOOP_TOOL,
          input: JSON.stringify({ n: modelStep }),
        }],
        finishReason: 'tool-calls' as const,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        warnings: [],
      };
    }

    // loop_tool was removed (intervention applied) OR no-tool forced → finish.
    return {
      content: [{ type: 'text' as const, text: 'Done — re-planned after the loop was broken.' }],
      finishReason: 'stop' as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      warnings: [],
    };
  }) as any,
});

// ── Real reflector + production-mirrored prepareStep closure ──
const runId = `e2e-reflector-${Date.now()}`;
const reflector = new StrategyReflector({
  runId,
  agentId: 'e2e-agent',
  originalPrompt: 'loop the tool',
  config: { warmupSteps: 1, maxToolRepetitions: MAX_TOOL_REPETITIONS, maxReflectionsPerRun: 5 },
});

let interventionLevers: string[] = [];
let prepareStepCalls = 0;

const prepareStep = async (args: Record<string, unknown>) => {
  prepareStepCalls += 1;
  const stepNumber = typeof args.stepNumber === 'number' ? args.stepNumber : 0;
  const rawSteps = Array.isArray(args.steps) ? args.steps as Array<Record<string, unknown>> : [];
  const systemMessages = Array.isArray(args.systemMessages) ? args.systemMessages as Array<Record<string, unknown>> : [];
  const state = (args.state && typeof args.state === 'object') ? args.state as Record<string, unknown> : {};

  const decision = reflector.evaluateHistory(normalizeSteps(rawSteps));
  if (decision.action !== 'inject_reflection' || !decision.intervention) return undefined;
  if (reflector.isReflectionBudgetExhausted()) return undefined;
  const lastStep = typeof state.lastInterventionStep === 'number' ? state.lastInterventionStep : -Infinity;
  if (stepNumber - lastStep < INTERVENTION_COOLDOWN_STEPS) return undefined;
  state.lastInterventionStep = stepNumber;
  reflector.recordIntervention(decision, stepNumber);

  const iv = decision.intervention;
  const result: Record<string, unknown> = {};
  interventionLevers = [];
  if (iv.injectSystem) {
    result.systemMessages = [...systemMessages, { role: 'system', content: iv.injectSystem }];
    interventionLevers.push('injectSystem');
  }
  if (iv.dropTools?.length) {
    const allow = toolUniverse.filter((t) => !iv.dropTools!.includes(t));
    if (allow.length > 0) { result.activeTools = allow; interventionLevers.push('dropTools'); }
  }
  if (iv.forceNoTool) { result.toolChoice = 'none'; interventionLevers.push('forceNoTool'); }
  return result;
};

// ── The real Mastra agent ──
const agent = new Agent({
  id: 'e2e-reflector-agent',
  name: 'e2e-reflector-agent',
  instructions: 'You repeatedly call loop_tool.',
  model: model as any,
  tools: { [LOOP_TOOL]: loopTool, [ESCAPE_TOOL]: escapeTool },
});

const originalWarn = console.warn;
console.warn = () => {};
let result: any;
try {
  result = await agent.generate('Please use the loop_tool.', {
    maxSteps: 12,
    prepareStep,
  } as any);
} finally {
  console.warn = originalWarn;
}

// ── Assertions ──
const reflections = reflector.getTriggeredReflections();
const loopReflection = reflections.find((r) => r.signal === 'tool_loop');

assert.ok(result, 'agent.generate must resolve a result (run did not crash)');
assert.ok(loopReflection, `expected a tool_loop intervention to be recorded; got: ${reflections.map((r) => r.signal).join(',') || 'none'}`);
assert.ok(interventionLevers.includes('dropTools'), `expected dropTools lever applied; got: ${interventionLevers.join(',') || 'none'}`);

// Mastra must have offered loop_tool early, then STOPPED offering it (override honored).
const earlyOfferedLoop = offeredToolNamesPerCall.slice(0, MAX_TOOL_REPETITIONS).some((names) => names.includes(LOOP_TOOL));
const laterWithoutLoop = offeredToolNamesPerCall.some((names) => names.length > 0 && !names.includes(LOOP_TOOL));
assert.ok(earlyOfferedLoop, 'loop_tool should have been offered to the model early on');
assert.ok(laterWithoutLoop, `Mastra did NOT honor activeTools — loop_tool was never removed. Offered per call: ${JSON.stringify(offeredToolNamesPerCall)}`);

assert.equal(result.finishReason, 'stop', `expected the run to terminate with finishReason=stop, got ${result.finishReason}`);

console.log('✅ E2E prepareStep actuator: Mastra invoked prepareStep and honored activeTools override.');
console.log(`   • model calls: ${offeredToolNamesPerCall.length}`);
console.log(`   • tools offered per call: ${JSON.stringify(offeredToolNamesPerCall)}`);
console.log(`   • intervention signal: ${loopReflection!.signal} @ step ${loopReflection!.stepNumber}, levers: ${interventionLevers.join('+')}`);
console.log(`   • final text: ${JSON.stringify(result.text)}`);
