#!/usr/bin/env tsx
/**
 * E2E (deterministic) — Reflektor: the tool_loop withdrawal must HOLD across the
 * per-signal cooldown.
 *
 * Why this exists: `e2e-reflector-prepare-step.ts` proves the drop takes hold
 * ONCE, but its mock finishes the moment the looping tool disappears — so it can
 * never observe what a real model does, which is wait one step and call the tool
 * again. Production did exactly that: on run `delegation-cd136dd3`
 * (automationArchitect, 2026-08-24) `tool_loop` fired at steps
 * 12/14/16/18/20/22/24 — every EVEN step, because the odd steps were the
 * cooldown gaps that handed `mastra_workspace_execute_command` straight back —
 * while the call count climbed 3 → 12. The lever oscillated instead of latching.
 *
 * This test drives the REAL `generateWithHarness` (not a hand-mirrored copy of
 * its closure, which is how the drift went unnoticed) with a model that calls
 * the looping tool whenever it is offered, and asserts that once the reflector
 * withdraws the tool it stays withdrawn on the very next step too.
 *
 * Run: npx tsx src/mastra/scripts/e2e-reflector-cooldown-hold.ts
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

const LOOP_TOOL = 'mastra_workspace_execute_command';
const ESCAPE_TOOL = 'architect_resolve_credentials';

// Succeeds every time with real-looking output. This mirrors the production
// shape: HARNESS_POLICY_MODE is `log_only`, so the shell genuinely ran and
// returned content — the loop was never an error loop, which is why the
// error-rate and trivial-result backstops could not see it.
const loopTool = createTool({
  id: LOOP_TOOL,
  description: 'Runs a shell command.',
  inputSchema: z.object({ command: z.string() }),
  outputSchema: z.object({ stdout: z.string(), exitCode: z.number() }),
  execute: async () => ({ stdout: 'total 42\ndrwxr-xr-x 3 node node 4096 .n8n', exitCode: 0 }),
});

const escapeTool = createTool({
  id: ESCAPE_TOOL,
  description: 'Resolves the credential the right way.',
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

/** Tool names offered to the model on each call, in order. */
const offeredPerCall: string[][] = [];

const model = new MockLanguageModelV3({
  modelId: 'mock-reflector-cooldown-e2e',
  doGenerate: (async (options: any) => {
    const offered: string[] = Array.isArray(options.tools)
      ? options.tools.map((t: any) => t.name).filter(Boolean)
      : [];
    offeredPerCall.push(offered);

    // The behaviour the old test never modelled: take the looping tool EVERY
    // time it is on the table, however many times it has already been used.
    if (offered.includes(LOOP_TOOL) && options.toolChoice?.type !== 'none') {
      return {
        content: [{
          type: 'tool-call' as const,
          toolCallId: `call-${offeredPerCall.length}`,
          toolName: LOOP_TOOL,
          input: JSON.stringify({ command: `ls -la /var/probe-${offeredPerCall.length}` }),
        }],
        finishReason: 'tool-calls' as const,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        warnings: [],
      };
    }
    return {
      content: [{ type: 'text' as const, text: 'Loop broken — resolving the credential properly instead.' }],
      finishReason: 'stop' as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      warnings: [],
    };
  }) as any,
});

const agent = new Agent({
  id: 'e2e-reflector-cooldown-agent',
  name: 'e2e-reflector-cooldown-agent',
  instructions: 'Investigate using the shell.',
  model: model as any,
  tools: { [LOOP_TOOL]: loopTool, [ESCAPE_TOOL]: escapeTool },
});

const runId = `e2e-reflector-cooldown-${Date.now()}`;
const originalWarn = console.warn;
console.warn = () => {};
try {
  await generateWithHarness({
    agent: agent as any,
    agentId: 'automationArchitect',
    prompt: 'Find the n8n credential on this host and repair the workflow.',
    taskId: runId,
    runId,
    threadId: runId,
    phase: 'chat',
    timeoutMs: 120_000,
  });
} finally {
  console.warn = originalWarn;
}

// ── Assertions ──
// The harness leaves Mongo/telemetry handles open, so a thrown assertion would
// idle instead of surfacing — report the failure and exit non-zero explicitly.
process.on('uncaughtException', (err) => {
  console.error(`❌ E2E cooldown-hold FAILED: ${(err as Error).message}`);
  process.exit(1);
});

const offeredLoop = offeredPerCall.map((names) => names.includes(LOOP_TOOL));
const summary = offeredLoop.map((v) => (v ? 'L' : '·')).join('');

assert.ok(
  offeredPerCall.length >= 3,
  `expected the run to reach the loop threshold, got ${offeredPerCall.length} model call(s)`,
);

const firstDrop = offeredLoop.indexOf(false);
assert.notEqual(
  firstDrop,
  -1,
  `the reflector never withdrew ${LOOP_TOOL} — tool_loop intervention did not reach activeTools (offered: ${summary})`,
);

// The regression itself: the step AFTER the withdrawal is the cooldown step.
// Before the fix it handed the tool straight back, which is what let the model
// resume the loop one step later.
if (firstDrop + 1 < offeredLoop.length) {
  assert.equal(
    offeredLoop[firstDrop + 1],
    false,
    `${LOOP_TOOL} came back on the cooldown step (offered: ${summary}) — `
    + 'the withdrawal must hold across interventionCooldownSteps, not oscillate',
  );
}

// And it must never reappear later in the same run while it is still looping.
const cameBackLater = offeredLoop.slice(firstDrop).some(Boolean);
assert.equal(
  cameBackLater,
  false,
  `${LOOP_TOOL} was re-offered after being withdrawn (offered: ${summary})`,
);

console.log('✅ E2E cooldown-hold: the looping tool stayed withdrawn across the cooldown.');
console.log(`   • model calls            : ${offeredPerCall.length}`);
console.log(`   • loop tool offered      : ${summary}  (L = offered, · = withheld)`);
console.log(`   • withdrawn from call    : #${firstDrop + 1}`);

// The harness leaves Mongo/telemetry handles open; exit explicitly so the script
// terminates (and flushes a piped stdout) instead of idling on them.
process.exit(0);
