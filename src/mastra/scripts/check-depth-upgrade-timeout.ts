import assert from 'node:assert/strict';
import type { Agent } from '@mastra/core/agent';
import {
  setRunDeadline,
  clearRunDeadline,
  getRemainingRunBudgetMs,
  upgradeRunDeadline,
} from '../services/run-budget.js';
import {
  upgradeRunDepth,
  getRunDepth,
  setRunDepth,
  disposeRunDepth,
  getDepthProfile,
} from '../services/depth-controller.js';
import { generateWithHarness } from '../services/generate-with-harness.js';

console.log('--- 1. Testing upgradeRunDeadline directly ---');

const testRunId1 = `test-deadline-upgrade-${Date.now()}`;
const startTime = Date.now();
setRunDeadline(testRunId1, startTime + 1000, startTime);

const initialRemaining = getRemainingRunBudgetMs(testRunId1, startTime);
assert.equal(initialRemaining, 1000, 'Initial remaining budget should be 1000ms');

// Upgrade to standard profile timeout (600_000ms)
const upgraded = upgradeRunDeadline(testRunId1, 600_000, undefined, startTime + 200);
assert.equal(upgraded, true, 'upgradeRunDeadline should return true');

const upgradedRemaining = getRemainingRunBudgetMs(testRunId1, startTime + 200);
assert.ok(
  upgradedRemaining !== undefined && upgradedRemaining >= 599_000,
  `Upgraded remaining budget should be ~600_000ms, got ${upgradedRemaining}`,
);

clearRunDeadline(testRunId1);
assert.equal(getRemainingRunBudgetMs(testRunId1), undefined);
console.log('✓ upgradeRunDeadline directly verified');

console.log('--- 2. Testing upgradeRunDepth automatically updates run-budget ---');

const testRunId2 = `test-depth-upgrade-${Date.now()}`;
const start2 = Date.now();
setRunDepth(testRunId2, 'fast');
setRunDeadline(testRunId2, start2 + getDepthProfile('fast').timeoutMs, start2);

assert.equal(getRunDepth(testRunId2), 'fast');
const fastTimeout = getDepthProfile('fast').timeoutMs;
assert.equal(fastTimeout, 180_000, 'fast profile timeoutMs should be 180_000ms (180s)');

// Trigger upgradeRunDepth
const depthUpgraded = upgradeRunDepth(testRunId2, 'standard', 'Reflector triggered: low_progress');
assert.equal(depthUpgraded, true, 'upgradeRunDepth should succeed');
assert.equal(getRunDepth(testRunId2), 'standard');

const remainingAfterDepthUpgrade = getRemainingRunBudgetMs(testRunId2, start2 + 500);
assert.ok(
  remainingAfterDepthUpgrade !== undefined && remainingAfterDepthUpgrade > 500_000,
  `Budget should have been automatically extended to ~600s, got ${remainingAfterDepthUpgrade}ms`,
);

disposeRunDepth(testRunId2);
clearRunDeadline(testRunId2);
console.log('✓ upgradeRunDepth automatic budget extension verified');

console.log('--- 3. Testing generateWithHarness with mock agent ---');

class MockDelayedAgent {
  async generate(prompt: string, options: Record<string, any> = {}) {
    if (typeof options.onStepFinish === 'function') {
      await options.onStepFinish({
        toolCalls: [
          { toolCallId: 'call-1', toolName: 'test_tool', args: { q: 'status' } },
        ],
        toolResults: [
          { toolCallId: 'call-1', toolName: 'test_tool', result: { ok: true } },
        ],
      });
    }

    // Small delay to simulate async reasoning
    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      text: 'Mock generation completed successfully.',
      steps: [],
      finishReason: 'stop',
    };
  }
}

const mockAgent = new MockDelayedAgent();
const testRunId3 = `harness-upgrade-run-${Date.now()}`;

const result = await generateWithHarness({
  agent: mockAgent as unknown as Agent,
  agentId: 'meta-agent',
  prompt: 'sprawdź stan zadań',
  taskId: testRunId3,
  runId: testRunId3,
  phase: 'chat',
});

assert.ok(result.response, 'Harness should return a response');
const responseObj = result.response as { text?: string };
assert.equal(responseObj.text, 'Mock generation completed successfully.');
console.log('✓ generateWithHarness completed successfully');

console.log('\nAll dynamic deadline and depth upgrade tests PASSED.');
process.exit(0);
