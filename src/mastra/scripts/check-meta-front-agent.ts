#!/usr/bin/env tsx
/**
 * F5 — the Meta Front agent (§4.1, `front_only`).
 *
 * The front's defining property is that it CANNOT block. That has to be a
 * structural fact, not a promise in its prompt: an agent that merely *says* it
 * will not run long tools will run them the moment a model decides to. So the
 * assertions here are about its actual toolset and shape.
 *
 * What this pins:
 *  1. Its toolset is EXACTLY the durable-job command surface — nothing else.
 *  2. No long/mutating capability is reachable (shell, git, n8n, browser, media,
 *     delegation, raw db). Checked by category against the real tool ids, so a
 *     future "just one more tool" addition has to fail here first.
 *  3. It is a genuinely separate agent from `metaAgent`, which keeps its own
 *     (large) toolset — the cutover is deliberately not part of this step.
 *  4. Its prompt states the non-blocking contract, since that is what steers the
 *     model's classification decisions.
 *
 * Run: npx tsx src/mastra/scripts/check-meta-front-agent.ts
 */
import assert from 'node:assert/strict';

const { metaFrontAgent } = await import('../agents/meta-front-agent.js');
const { metaAgent } = await import('../agents/meta-agent.js');
const { durableJobTools } = await import('../tools/system/orchestration-job-tools.js');

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

async function toolIdsOf(agent: unknown): Promise<string[]> {
  const tools = await (agent as { listTools: () => Promise<Record<string, unknown>> }).listTools();
  return Object.keys(tools).sort();
}

console.log('check:meta-front-agent');

await check('its toolset is EXACTLY the durable-job command surface', async () => {
  const actual = await toolIdsOf(metaFrontAgent);
  const expected = Object.keys(durableJobTools).sort();
  assert.deepEqual(
    actual,
    expected,
    `the front must carry the job commands and nothing else.\n  got:      ${actual.join(', ')}\n  expected: ${expected.join(', ')}`,
  );
  assert.equal(actual.length, 10, 'all ten commands should be present');
});

await check('no long or mutating capability is reachable from the front', async () => {
  const ids = (await toolIdsOf(metaFrontAgent)).join(' ').toLowerCase();
  // Categories §4.1 explicitly excludes. Substring matching is intentional: it
  // catches a whole family, not one exact id someone might rename around.
  const forbidden = [
    'shell', 'command', 'exec', 'terminal',
    'git', 'worktree', 'repo',
    'file', 'write', 'read_file',
    'n8n', 'workflow', 'webhook',
    'browser', 'playwright', 'scrape',
    'image', 'film', 'music', 'tts', 'generate_',
    'delegate', 'worker', 'spawn',
    'mongo', 'database', 'query_db',
    'email', 'telegram', 'send',
  ];
  const hits = forbidden.filter((needle) => ids.includes(needle));
  assert.deepEqual(hits, [], `the front must not reach long/mutating capabilities, found: ${hits.join(', ')}`);
});

await check('the front is a SEPARATE agent — metaAgent keeps its own toolset', async () => {
  const frontIds = await toolIdsOf(metaFrontAgent);
  const metaIds = await toolIdsOf(metaAgent);
  assert.ok(metaIds.length > frontIds.length, 'metaAgent must still be the broad agent');
  assert.ok(
    metaIds.length > 20,
    `metaAgent must keep its capabilities — the front_only cutover is Wave 5, not this step (got ${metaIds.length})`,
  );
  assert.notEqual((metaFrontAgent as { id?: string }).id, (metaAgent as { id?: string }).id);
});

await check('the prompt states the non-blocking contract that drives its decisions', async () => {
  const { loadPrompt } = await import('../lib/prompt-loader.js');
  const prompt = (await loadPrompt('meta-front/base')).toLowerCase();
  for (const phrase of ['never block', 'durable job', 'jobid']) {
    assert.ok(prompt.includes(phrase), `the prompt must establish "${phrase}"`);
  }
  assert.ok(
    prompt.includes('do not') || prompt.includes('you do not'),
    'the prompt must state what the front does NOT do',
  );
});

await check('CANARY REGRESSION: the front is told not to do the specialists\' work itself', async () => {
  // Asked to design a tasting menu, the front wrote the menu — plausibly, and
  // instead of giving the job to chefAgent, which has the recon tools and the
  // actual pipeline. "Answer directly when you can" reads to a model as "answer
  // anything you can produce text for", which quietly reinstates the single
  // generalist this whole engine exists to replace. Found on the first
  // capability-routing canary.
  const { loadPrompt } = await import('../lib/prompt-loader.js');
  const prompt = (await loadPrompt('meta-front/base')).toLowerCase();
  assert.ok(
    prompt.includes('orchestration_start_job'),
    'the prompt must name the tool that a request for work turns into',
  );
  assert.ok(
    prompt.includes('could just answer'),
    'and must name the trap by its own words, since that is the reasoning the model performs',
  );
  assert.ok(
    prompt.includes('specialist'),
    'and must say why answering it itself is the worse outcome',
  );
});

if (failures > 0) {
  console.error(`\n❌ check:meta-front-agent — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:meta-front-agent — the front is structurally incapable of blocking: job commands only');
process.exit(0);
