/**
 * FULL live run of the contentAgent through the real pipeline wrapper.
 *
 * Content's pipeline runs autonomously until the first HARD checkpoint
 * (`checkpoint_strategy`), where it ends the turn and awaits approval — so a
 * single delegation naturally traverses intake → research → strategy →
 * checkpoint_strategy and stops cleanly (no hang). That gives ~4 real phase
 * transitions to observe per-phase tool channeling + any reflector levers.
 *
 * Resolves the agent via the Mastra instance (inherits storage/memory) exactly
 * like delegate-task.ts. Dumps ALL pipeline_* telemetry chronologically.
 */
import 'dotenv/config';

const { mastra } = await import('../index.js');
const contentAgent = mastra.getAgent('contentAgent');
const { generatePipelineWithReflection } = await import('../services/generate-pipeline-with-reflection.js');
const { queryAgentEvents } = await import('../lib/agent-event-log.js');

const since = new Date();
const threadId = `live-content-${Date.now()}`;

// A real but small content brief. Lets research/strategy do genuine work, then
// the agent will stop at checkpoint_strategy for approval.
const prompt = [
  'Create a content pack for a small specialty coffee roastery called "Świt Coffee" based in Wrocław, Poland.',
  'Audience: local coffee enthusiasts + remote workers. Goal: grow Instagram presence.',
  'Platforms: Instagram + LinkedIn. Tone: warm, knowledgeable, not pretentious.',
  'Run the pipeline through research and strategy, then present the angle/format calendar at the strategy checkpoint for approval.',
].join('\n');

console.log(`[live] starting contentAgent via pipeline wrapper (thread=${threadId})`);
const started = Date.now();

const timeoutMs = 480_000; // 8 min wall-clock ceiling
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; }, timeoutMs);

try {
  const result = await Promise.race([
    generatePipelineWithReflection({
      agent: contentAgent as never,
      agentKey: 'contentAgent',
      agentId: 'contentAgent',
      prompt,
      threadId,
      resourceId: 'live-content-test',
    }),
    new Promise<{ text: string; runId: string }>((resolve) =>
      setTimeout(() => resolve({ text: '[timed out]', runId: 'n/a' }), timeoutMs),
    ),
  ]);
  clearTimeout(timer);
  console.log(`[live] run finished in ${((Date.now() - started) / 1000).toFixed(0)}s (timedOut=${timedOut}).`);
  console.log(`[live] runId=${result.runId}`);
  console.log('[live] final text preview:');
  console.log('   ' + (result.text || '').slice(0, 600).replace(/\n/g, ' '));
} catch (err) {
  clearTimeout(timer);
  console.error('[live] run threw (wrapper should fail-open):', (err as Error).message);
}

await new Promise((r) => setTimeout(r, 1500));

// Pull every pipeline_* event since the run started, merge, sort chronologically.
const types = ['pipeline_phase_transition', 'pipeline_phase_tools_applied', 'pipeline_reflector_intervention'] as const;
const all: Array<{ type: string; ts: number; step: number; data: unknown }> = [];
for (const type of types) {
  const events = await queryAgentEvents({ type, since, limit: 100 });
  for (const e of events) {
    const ts = new Date((e as { createdAt?: string | Date }).createdAt ?? Date.now()).getTime();
    const data = (e as { data?: { stepNumber?: number } }).data;
    all.push({ type, ts, step: typeof data?.stepNumber === 'number' ? data.stepNumber : 0, data });
  }
}
// Sort by timestamp, then stepNumber (events emitted in the same ms otherwise
// print in arbitrary order — e.g. a later phase before an earlier one).
all.sort((a, b) => a.ts - b.ts || a.step - b.step);

console.log(`\n[live] pipeline_* telemetry (chronological, ${all.length} events):`);
for (const e of all) {
  console.log(`  ${e.type.replace('pipeline_', '')}: ${JSON.stringify(e.data)}`);
}

// Summary counts.
console.log('\n[live] counts:');
for (const type of types) {
  console.log(`  ${type}: ${all.filter((e) => e.type === type).length}`);
}

console.log('\n[live] done.');
process.exit(0);
