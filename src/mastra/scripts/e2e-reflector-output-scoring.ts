/**
 * E2E (deterministic) — Reflektor Part 2 §2.7: native isTaskComplete scoring.
 *
 * Goal: prove that Mastra's REAL `agent.generate()` loop runs our completion
 * scorer (`createGoalCompletionScorer`) after each iteration, RE-ITERATES with
 * auto-injected feedback while the scorer returns 0, and FINALIZES once it
 * returns 1 — and that `onComplete` fires.
 *
 * Mechanism: a GoalContract starts incomplete (scorer → 0). A scripted
 * MockLanguageModelV3 emits a plain text answer each call; on its 2nd call it
 * marks the contract's step done + records supporting evidence, so the NEXT
 * scorer evaluation flips to 1 and the loop ends. We assert the model was
 * called more than once (re-iteration happened) and that `onComplete` observed
 * a completed run.
 *
 * Mongo-backed: SKIPS (exit 0) if Mongo is unreachable.
 *
 * Run: npx tsx src/mastra/scripts/e2e-reflector-output-scoring.ts
 */
import assert from 'node:assert/strict';

process.env.FEATURE_OUTPUT_SCORING = 'true';
process.env.DISABLE_REFLECTOR_TELEMETRY = '1';

const { getDb } = await import('../lib/mongo.js');

try {
  const db = await getDb();
  await db.command({ ping: 1 });
} catch (err) {
  console.log(`⏭️  output-scoring E2E SKIPPED — Mongo unreachable: ${(err as Error).message}`);
  process.exit(0);
}

const { Agent } = await import('@mastra/core/agent');
const { MockLanguageModelV3 } = await import('ai/test');
const { createGoalCompletionScorer } = await import('../scorers/goal-completion-scorer.js');
const { createGoalContract, recordEvidence } = await import('../services/goal-tracker.js');

// ── A contract that starts incomplete ──
const contract = await createGoalContract({
  taskId: `output-scoring-e2e-${Date.now()}`,
  agentId: 'e2e-agent',
  originalGoal: 'Produce a verified answer',
  plannedSteps: [{ description: 'Answer + verify', targetAgent: 'e2e-agent' }],
  successCriteria: ['Answer is verified'],
});

// ── Scripted mock model: text answer each call; mark the contract done on the
// 2nd call so the subsequent scorer evaluation flips 0 → 1. ──
let modelCalls = 0;
const model = new MockLanguageModelV3({
  modelId: 'mock-output-scoring-e2e',
  doGenerate: (async () => {
    modelCalls += 1;
    if (modelCalls === 2) {
      await recordEvidence(contract.contractId, {
        stepId: 'step-1',
        type: 'for',
        description: 'Answer produced and verified.',
        stepStatus: 'done',
      });
    }
    return {
      content: [{ type: 'text' as const, text: `Answer attempt #${modelCalls}.` }],
      finishReason: 'stop' as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      warnings: [],
    };
  }) as any,
});

let onCompleteSawComplete = false;
let onCompleteCalls = 0;

const agent = new Agent({
  id: 'e2e-output-scoring-agent',
  name: 'e2e-output-scoring-agent',
  instructions: 'You produce a verified answer.',
  model: model as any,
});

const originalLog = console.log;
const originalWarn = console.warn;
console.warn = () => {};
let result: any;
try {
  result = await agent.generate('Give me a verified answer.', {
    isTaskComplete: {
      scorers: [createGoalCompletionScorer(contract.contractId)],
      strategy: 'all' as const,
      onComplete: (r: { complete?: boolean }) => {
        onCompleteCalls += 1;
        if (r.complete) onCompleteSawComplete = true;
      },
    },
  } as any);
} finally {
  console.warn = originalWarn;
  console.log = originalLog;
}

// ── Cleanup ──
const db = await getDb();
await db.collection('goal_contracts').deleteMany({ contractId: contract.contractId });

// ── Assertions ──
assert.ok(result, 'agent.generate must resolve a result (run did not crash)');
assert.ok(modelCalls > 1, `expected re-iteration (model called >1×) while scorer returned 0; got ${modelCalls}`);
assert.ok(onCompleteCalls > 0, 'expected isTaskComplete.onComplete to fire at least once');
assert.ok(onCompleteSawComplete, 'expected onComplete to eventually observe a completed run');

console.log('✅ E2E output scoring: Mastra ran isTaskComplete, re-iterated while incomplete, then finalized.');
console.log(`   • model calls: ${modelCalls}`);
console.log(`   • onComplete invocations: ${onCompleteCalls} (saw complete: ${onCompleteSawComplete})`);
process.exit(0);
