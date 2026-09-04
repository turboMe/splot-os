#!/usr/bin/env tsx
/**
 * E2E — the give-up backstop must actually END a real harness run.
 *
 * `reflector_stop_when` had fired ZERO times in ~79k recorded events, across
 * runs that plainly qualified: automationArchitect, designAgent, knowledgeAgent
 * and deliberationAgent all logged 5–7 repeated `tool_loop` interventions
 * against a `maxRepeatedStuckInterventions` of 3. The class logic was fine and
 * `e2e-reflector-stop-when.ts` passed — but that test hand-mirrors the harness's
 * stopWhen closure instead of exercising it, so it could not have caught a
 * WIRING regression. Nothing tested the thing that was actually in doubt.
 *
 * This drives the real `generateWithHarness` and asserts the run is cut short by
 * the reflector, at `critical` depth (the profile production runs on, whose
 * reflector config differs: maxToolRepetitions 3, maxReflectionsPerRun 7) and
 * with the completion scorer installed (production always passes a
 * goalContractId, so `isTaskComplete` is always present — a plausible suspect
 * that this check rules out permanently).
 *
 * Run: npx tsx src/mastra/scripts/e2e-reflector-unrecoverable-stop.ts
 */
import 'dotenv/config';
import assert from 'node:assert/strict';

process.env.FEATURE_STRATEGY_REFLECTOR = 'true';
process.env.FEATURE_REFLECTOR_PREPARE_STEP = 'true';
process.env.FEATURE_REFLECTOR_STOP_WHEN = 'true';
process.env.DISABLE_REFLECTOR_TELEMETRY = '1';

const { Agent } = await import('@mastra/core/agent');
const { createTool } = await import('@mastra/core/tools');
const { z } = await import('zod');
const { MockLanguageModelV3 } = await import('ai/test');
const { generateWithHarness } = await import('../services/generate-with-harness.js');

const TOOL = 'mastra_workspace_execute_command';
/** `critical` allows 40 steps; being cut well below that is the whole assertion. */
const STEP_CEILING = 40;

const loopTool = createTool({
  id: TOOL,
  description: 'Runs a shell command.',
  inputSchema: z.object({ command: z.string() }),
  outputSchema: z.object({ stdout: z.string(), exitCode: z.number() }),
  // Non-trivial, varied, SUCCESSFUL output on purpose: under
  // HARNESS_POLICY_MODE=log_only the shell really ran, so the live loop was
  // never an error loop and never an empty-result loop. Every backstop keyed on
  // failure or triviality was blind to it — only the repeated-intervention one
  // could see it, which is exactly the path under test.
  execute: async () => ({
    stdout: `drwxr-xr-x 3 node node 4096 ${Math.random().toString(36).slice(2)} .n8n`,
    exitCode: 0,
  }),
});

let modelCalls = 0;
const model = new MockLanguageModelV3({
  modelId: 'mock-unrecoverable-e2e',
  doGenerate: (async (options: any) => {
    modelCalls += 1;
    const offered: string[] = Array.isArray(options.tools)
      ? options.tools.map((t: any) => t.name).filter(Boolean)
      : [];
    // Take the tool whenever it is offered; when it is withheld, say something
    // and ask for it back. A model that gives up on its own would prove nothing.
    if (offered.includes(TOOL) && options.toolChoice?.type !== 'none') {
      return {
        content: [{
          type: 'tool-call' as const,
          toolCallId: `c-${modelCalls}`,
          toolName: TOOL,
          input: JSON.stringify({ command: `ls -la /var/probe-${modelCalls}` }),
        }],
        finishReason: 'tool-calls' as const,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        warnings: [],
      };
    }
    return {
      content: [{ type: 'text' as const, text: 'Still looking for the credential on this host.' }],
      finishReason: 'stop' as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      warnings: [],
    };
  }) as any,
});

const agent = new Agent({
  id: 'e2e-unrecoverable-agent',
  name: 'e2e-unrecoverable-agent',
  instructions: 'Investigate using the shell.',
  model: model as any,
  tools: { [TOOL]: loopTool },
});

const runId = `e2e-reflector-unrecoverable-${Date.now()}`;

// A goalContractId installs `isTaskComplete`; production always has one.
const { createGoalContract } = await import('../services/goal-tracker.js');
const contract = await createGoalContract({
  taskId: runId,
  agentId: 'automationArchitect',
  originalGoal: 'Activate the workflow, run a real test and repair any defect found.',
}).catch(() => undefined);

const originalWarn = console.warn;
console.warn = () => {};
let result: any;
try {
  result = await generateWithHarness({
    agent: agent as any,
    agentId: 'automationArchitect',
    // Long/complex on purpose so depth classification lands on `critical`.
    prompt:
      'GOAL: Activate the existing n8n workflow FX Exposure Alert, run an end-to-end test with real '
      + 'credentials, verify the MongoDB write, diagnose any failure, repair the workflow, redeploy, '
      + 'retest and return a terminal status. CONTEXT: the previous real test failed with an '
      + 'authentication error on the Mongo node; investigate the host and determine the credential.',
    taskId: runId,
    runId,
    threadId: runId,
    phase: 'chat',
    timeoutMs: 180_000,
    ...(contract?.contractId ? { goalContractId: contract.contractId } : {}),
  });
} finally {
  console.warn = originalWarn;
}

// Read every field a caller might look at: the blocker used to be stamped on a
// response that a later pass replaced, so it was present in none of them.
const text: string = [
  (result as any)?.response?.text,
  (result as any)?.outputPreview,
  (result as any)?.deliverableText,
].filter((v) => typeof v === 'string').join('\n');

assert.ok(
  modelCalls > 3,
  `the loop must actually get going before the backstop can judge it, got ${modelCalls} model call(s)`,
);
assert.ok(
  modelCalls < STEP_CEILING,
  `the run must be CUT SHORT, not burn the ${STEP_CEILING}-step ceiling — got ${modelCalls} model calls`,
);
assert.match(
  text,
  /stopped early by the strategy reflector|trajectory is unrecoverable/i,
  'the run must carry the reflector\'s unrecoverable blocker; without it the predicate is wired but inert '
  + `(text was: ${text.slice(0, 300)})`,
);

console.log('✅ E2E unrecoverable-stop: the backstop ended a real harness run at critical depth.');
console.log(`   • model calls        : ${modelCalls} (ceiling ${STEP_CEILING})`);
console.log(`   • completion scorer  : ${contract?.contractId ? 'installed' : 'absent'}`);
console.log(`   • blocker            : present`);

process.exit(0);
