/**
 * LIVE smoke test for the Part 3 pipeline wrapper (NOT a CI check).
 *
 * Runs the REAL chefAgent through the actual `generatePipelineWithReflection`
 * wrapper with a tiny, bounded brief, then reports the `pipeline_*` telemetry
 * the run emitted. Proves the new routing/prepareStep path is live end-to-end
 * against a real model + agent. Bounded by an overall wall-clock timeout.
 */
import 'dotenv/config';

// Resolve the agent via the Mastra instance (NOT a bare import) so it inherits
// the instance storage/memory provider — exactly like delegate-task.ts does.
const { mastra } = await import('../index.js');
const chefAgent = mastra.getAgent('chefAgent');
const { generatePipelineWithReflection } = await import('../services/generate-pipeline-with-reflection.js');
const { queryAgentEvents } = await import('../lib/agent-event-log.js');

const since = new Date();
const threadId = `live-pipeline-${Date.now()}`;

// Deliberately tiny, bounded brief: do ONE real phase transition then stop.
const prompt = [
  'SMOKE TEST — do the minimum and then stop.',
  'GOAL: start a chef project for a tiny imaginary bistro called "Test Bistro" (Polish cuisine, lunch only),',
  'set its status to the intake phase, then STOP and reply with a one-line confirmation.',
  'CONTEXT: this is an automated wiring test, not a real menu task.',
  'CONSTRAINTS: do NOT run recon, do NOT generate a menu, do NOT delegate. At most 3 tool calls total.',
].join('\n');

console.log(`[live] starting chefAgent via pipeline wrapper (thread=${threadId})`);

const timeoutMs = 150_000;
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; }, timeoutMs);

try {
  const result = await Promise.race([
    generatePipelineWithReflection({
      agent: chefAgent as never,
      agentKey: 'chefAgent',
      agentId: 'chefAgent',
      prompt,
      threadId,
      resourceId: 'live-pipeline-test',
    }),
    new Promise<{ text: string; runId: string }>((resolve) =>
      setTimeout(() => resolve({ text: '[timed out]', runId: 'n/a' }), timeoutMs),
    ),
  ]);
  clearTimeout(timer);
  console.log(`[live] run finished (timedOut=${timedOut}). text preview:`);
  console.log('   ' + (result.text || '').slice(0, 300).replace(/\n/g, ' '));
} catch (err) {
  clearTimeout(timer);
  console.error('[live] run threw (wrapper should fail-open, run still completes):', (err as Error).message);
}

// Give fire-and-forget telemetry a moment to flush.
await new Promise((r) => setTimeout(r, 1500));

const types = ['pipeline_phase_transition', 'pipeline_phase_tools_applied', 'pipeline_reflector_intervention'] as const;
console.log('\n[live] pipeline_* telemetry emitted during this run:');
for (const type of types) {
  const events = await queryAgentEvents({ type, since, limit: 20 });
  console.log(`  ${type}: ${events.length}`);
  for (const e of events.slice(0, 5)) {
    console.log(`    • ${JSON.stringify(e.data)}`);
  }
}

console.log('\n[live] done.');
process.exit(0);
