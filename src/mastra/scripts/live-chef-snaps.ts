/**
 * FULL live run: chefAgent designs a brand-new Menu Book for SNAPS Bistro Bar
 * (https://www.snaps.is/en) through the real pipeline wrapper, end-to-end to PDF.
 *
 * Chef's pipeline is fully autonomous (no human gates — both checkpoints say
 * "proceed immediately"), so one delegation runs intake → recon → profile →
 * menu_draft → critic_gate → recipes → qa_final → render → done.
 *
 * Resolves the agent via the Mastra instance (inherits storage/memory) exactly
 * like delegate-task.ts. Dumps pipeline_* telemetry + locates the rendered
 * .md/.pdf artifact at the end.
 */
import 'dotenv/config';
import { readdirSync, statSync } from 'node:fs';

const { mastra } = await import('../index.js');
const chefAgent = mastra.getAgent('chefAgent');
const { generatePipelineWithReflection } = await import('../services/generate-pipeline-with-reflection.js');
const { queryAgentEvents } = await import('../lib/agent-event-log.js');

const since = new Date();
const threadId = `live-chef-snaps-${Date.now()}`;
const DOCS_DIR = process.env.CHEF_DOCS_DIR || '/projekty/splot-projects/menu-books';

const prompt = [
  'Prepare a COMPLETELY NEW menu for the restaurant "SNAPS Bistro Bar".',
  'Website: https://www.snaps.is/en — Þórsgata 1, Reykjavik, Iceland. A French-Danish bistro,',
  'casual-upscale, known for beef bourguignon, moules, fish of the day, onion soup, brunch.',
  '',
  'Run the FULL Menu Book pipeline autonomously, end to end:',
  '1. recon the current menu + reputation (delegate research, use reviews),',
  '2. synthesize the venue profile,',
  '3. design a completely new menu that elevates the concept while staying recognizably SNAPS',
  '   (French-Danish bistro identity), addressing any weaknesses found in reviews,',
  '4. run the critic gate, generate technical recipe cards for EVERY dish,',
  '5. QA, then RENDER the final Menu Book to PDF (chef_document_render + PDF).',
  '',
  'This is a real deliverable — go all the way to the rendered PDF and status "done".',
].join('\n');

console.log(`[chef-snaps] starting full pipeline (thread=${threadId})`);
console.log(`[chef-snaps] docs dir: ${DOCS_DIR}`);
const started = Date.now();

const timeoutMs = 1_800_000; // 30 min wall-clock ceiling
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
      resourceId: 'live-chef-snaps',
    }),
    new Promise<{ text: string; runId: string }>((resolve) =>
      setTimeout(() => resolve({ text: '[timed out]', runId: 'n/a' }), timeoutMs),
    ),
  ]);
  clearTimeout(timer);
  console.log(`\n[chef-snaps] run finished in ${((Date.now() - started) / 1000).toFixed(0)}s (timedOut=${timedOut}).`);
  console.log(`[chef-snaps] runId=${result.runId}`);
  console.log('[chef-snaps] final text:');
  console.log((result.text || '').slice(0, 2000));
} catch (err) {
  clearTimeout(timer);
  console.error('[chef-snaps] run threw:', (err as Error).message);
}

await new Promise((r) => setTimeout(r, 2000));

// ── pipeline_* telemetry (chronological) ──
const types = ['pipeline_phase_transition', 'pipeline_phase_tools_applied', 'pipeline_reflector_intervention'] as const;
const all: Array<{ type: string; ts: number; step: number; data: unknown }> = [];
for (const type of types) {
  const events = await queryAgentEvents({ type, since, limit: 200 });
  for (const e of events) {
    const ts = new Date((e as { createdAt?: string | Date }).createdAt ?? Date.now()).getTime();
    const data = (e as { data?: { stepNumber?: number } }).data;
    all.push({ type, ts, step: typeof data?.stepNumber === 'number' ? data.stepNumber : 0, data });
  }
}
all.sort((a, b) => a.ts - b.ts || a.step - b.step);
console.log(`\n[chef-snaps] pipeline_* telemetry (${all.length} events):`);
for (const e of all) console.log(`  ${e.type.replace('pipeline_', '')}: ${JSON.stringify(e.data)}`);
console.log('\n[chef-snaps] counts:');
for (const type of types) console.log(`  ${type}: ${all.filter((e) => e.type === type).length}`);

// ── locate the freshest rendered artifact (created during this run) ──
try {
  const files = readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md') || f.endsWith('.pdf'))
    .map((f) => ({ f, m: statSync(`${DOCS_DIR}/${f}`).mtimeMs, size: statSync(`${DOCS_DIR}/${f}`).size }))
    .filter((x) => x.m >= started - 5000)
    .sort((a, b) => b.m - a.m);
  console.log(`\n[chef-snaps] artifacts created during this run (${files.length}):`);
  for (const x of files) console.log(`  ${x.f}  (${(x.size / 1024).toFixed(0)} KB, mtime ${new Date(x.m).toISOString()})`);
} catch (e) {
  console.warn('[chef-snaps] could not scan docs dir:', (e as Error).message);
}

console.log('\n[chef-snaps] done.');
process.exit(0);
