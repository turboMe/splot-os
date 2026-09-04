#!/usr/bin/env tsx
/**
 * The headless output contract (plan step 3b) — telling a conversational
 * specialist that this run has nobody to talk to.
 *
 * Every failure pinned here came from a real job on the capability-routing
 * canary, none of them from review:
 *
 *  1. `chefAgent` answered "which cuisine? any dietary limits?" and the job
 *     closed COMPLETED with a question as its deliverable;
 *  2. asked again in almost the same words it invented a theme and delivered
 *     confidently — worse than asking, because a confident answer to a question
 *     nobody asked is indistinguishable from a good one;
 *  3. `writerAgent` returned the reflector's commentary ABOUT the story.
 *
 * So the contract must do three things at once, and the tests check all three:
 * demand the deliverable itself, forbid stopping on missing detail (decide and
 * STATE the assumption), and provide exactly one structural way to say "only the
 * user can unblock this" — structural, because recognizing a question by reading
 * the prose is what already failed.
 *
 * Run: npx tsx src/mastra/scripts/check-headless-contract.ts
 */
import assert from 'node:assert/strict';

import {
  buildHeadlessContract,
  parseNeedsInput,
  NEEDS_INPUT_MARKER,
} from '../orchestration/execution/headless-contract.js';
import { capabilityRoute } from '../orchestration/execution/registry-worker.js';
import {
  buildCapabilityRegistry, SIDE_EFFECT_PRODUCT_CAPABILITIES,
} from '../config/capability-routing.js';
import type { WorkerContext } from '../orchestration/store/worker.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

function workerCtx(over: Partial<WorkerContext> = {}): WorkerContext {
  return {
    attemptId: 'a', taskId: 't', jobId: 'j', attemptNumber: 1,
    businessOperationCutoffAt: new Date(Date.now() + 10_000),
    workDeadlineAt: new Date(Date.now() + 20_000),
    hardDeadlineAt: new Date(Date.now() + 30_000),
    goal: 'design a tasting menu', instructions: [],
    ...over,
  };
}

console.log('check:headless-contract');

check('LIVE REGRESSION 1+3: the contract demands the work itself, not a plan or a reflection', () => {
  const contract = buildHeadlessContract({ deliverable: 'document' });
  assert.match(contract, /FINAL message is stored as the result/i);
  assert.match(contract, /not a reflection/i, 'writerAgent returned commentary about the story');
  assert.match(contract, /document/, 'and the expected artifact must be named');
});

check('LIVE REGRESSION 2: missing detail is not a reason to stop, and not a licence to invent', () => {
  // The two failures are opposite errors, and the contract must rule out BOTH —
  // otherwise fixing one produces the other, which is what happened live.
  const contract = buildHeadlessContract();
  assert.match(contract, /state the assumptions/i, 'decide, but say what you decided');
  assert.match(contract, /quietly inventing/i, 'and never pass an invention off as the answer');
});

check('a specialist with no known artifact still gets the contract', () => {
  const contract = buildHeadlessContract();
  assert.match(contract, /FINAL message/i);
  assert.ok(!contract.includes('expected:'), 'it must not promise an artifact it does not know');
});

check('the run is told what day it is', () => {
  // Measured on the marketing canary: asked for a follow-up "next week", the run
  // booked 2026-05-28 while the real date was 2026-08-11 — anchored on an example
  // date inside a tool description, because a background job is told nothing else.
  const contract = buildHeadlessContract();
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(contract.includes(`Today is ${today}`), `the contract must state today (${today})`);
  assert.match(contract, /never from a date you saw in an example/i,
    'the anchor that caused it must be named, or the same substitution happens again');
});

check('an agent whose product is a side effect is told to leave one behind', () => {
  // Measured on the automationArchitect canary: the run deployed a workflow to
  // n8n (verified through the n8n API) and was still marked FAILED with
  // `empty_output`, because its last text was the harness's own scoring report.
  // The job then re-ran a task whose product already existed — which, for an
  // agent with side effects, is how one action becomes two.
  const contract = buildHeadlessContract({
    deliverable: 'automation_workflow',
    sideEffectProduct: true,
  });
  assert.match(contract, /artifact_put/,
    'saving the product must be named as the mechanism, not implied');
  assert.match(contract, /file is NOT enough|invisible to the job/i,
    'writing to a file is the trap this rule exists to close');
  assert.match(contract, /ids? it\s*\n?\s*got|workflow id/i,
    'the report must name what changed in the outside world');
  // Measured on the huntAgent canary: the run reported "CRM records created" for
  // two producers, and exactly one record existed — the other had been in the CRM
  // since May and was never touched. For an agent that writes outward, a report
  // overstating what it did is worse than a failure, because it looks like success
  // and nobody re-checks it before acting on it.
  assert.match(contract, /already existed.*not "created"|Report ONLY what your tools actually returned/is,
    'the report must be pinned to what the tools returned, not to what was attempted');
});

check('the side-effect rule reaches ONLY the capabilities it is meant for', () => {
  // The eight already-canaried agents must keep the prompt they were verified
  // with. A rule that quietly rewrites every agent's contract is a migration of
  // its own, not a fix for one.
  const plain = buildHeadlessContract({ deliverable: 'document' });
  assert.ok(!plain.includes('artifact_put'),
    'a text-producing capability must get an UNCHANGED contract');
  assert.ok(!plain.includes('OUTSIDE THIS CONVERSATION'));
});

check('the routing policy is the single source of who gets that rule', () => {
  // Not a second list in the worker: these facts were hand-kept in two places
  // once, and one of them was wrong about an agent for a whole stage.
  assert.ok(SIDE_EFFECT_PRODUCT_CAPABILITIES.has('automationArchitect'));
  assert.ok(!SIDE_EFFECT_PRODUCT_CAPABILITIES.has('crmAgent'),
    'read-only CRM must not be classed as an outward writer — it was once, wrongly');
  assert.ok(!SIDE_EFFECT_PRODUCT_CAPABILITIES.has('writerAgent'));
});

check('the escape hatch is exactly one structural marker', () => {
  const contract = buildHeadlessContract({ deliverable: 'document' });
  assert.match(contract, new RegExp(NEEDS_INPUT_MARKER));
  assert.match(contract, /last\s*resort/i, 'asking must be framed as expensive, not as a check-in');
});

check('a blocked run is recognized without a model in the loop', () => {
  assert.equal(
    parseNeedsInput('NEEDS_INPUT: Which cuisine, and any dietary limits?'),
    'Which cuisine, and any dietary limits?',
  );
  // Framing the model actually produces around it.
  assert.equal(parseNeedsInput('  \n`NEEDS_INPUT:` Which cuisine?'), 'Which cuisine?');
  assert.equal(parseNeedsInput('**NEEDS_INPUT:** Which cuisine?'), 'Which cuisine?');
});

check('a DELIVERED result is never mistaken for a question', () => {
  // The dangerous direction: a real deliverable that merely mentions the marker
  // (an agent quoting its own instructions) must not stop the job.
  const delivered = [
    '## Menu\n\n1. Beetroot tartare...',
    'Here is the menu. If I had been blocked I would have written NEEDS_INPUT: something.',
    'I assumed Polish seasonal cuisine.\n\nNEEDS_INPUT: is only for real blockers.',
    '',
  ];
  for (const text of delivered) {
    assert.equal(parseNeedsInput(text), null, `must be treated as delivered: ${text.slice(0, 40)}`);
  }
});

check('a marker with no question is not a question', () => {
  assert.equal(parseNeedsInput('NEEDS_INPUT:'), null);
  assert.equal(parseNeedsInput('NEEDS_INPUT:    '), null);
});

check('the question is bounded — a blocked run cannot push an essay through it', () => {
  const long = parseNeedsInput(`NEEDS_INPUT: ${'x'.repeat(5_000)}`);
  assert.ok(long && long.length <= 1_000, `got ${long?.length} chars`);
});

check('the contract reaches the agent, carrying ITS deliverable', () => {
  const registry = buildCapabilityRegistry({ allow: '*', defaultAgentId: 'researcherAgent' });
  const route = capabilityRoute({
    resolve: (n) => registry.resolve(n),
    defaultAgentId: 'researcherAgent',
    deliverableFor: (n) => registry.deliverableFor(n),
  });
  const prompt = route(workerCtx({ capability: 'chefAgent' }))?.prompt ?? '';
  assert.match(prompt, /design a tasting menu/, 'the goal must still lead');
  assert.match(prompt, /HOW THIS RUN WORKS/, 'and the contract must follow it');
  assert.match(prompt, /menu_book_ref/, "chef's own artifacts, read from its board card");
});

check('without the contract the prompt is byte-for-byte what it was before', () => {
  // The migration is per-capability and reversible: a mount that does not opt in
  // must see no change at all.
  const bare = capabilityRoute({ resolve: () => 'x', defaultAgentId: 'x' });
  const prompt = bare(workerCtx({ capability: null, instructions: ['be brief'] }))?.prompt;
  assert.equal(prompt, 'design a tasting menu\n\nAdditional instructions:\n- be brief');
});

if (failures > 0) {
  console.error(`\n❌ check:headless-contract — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:headless-contract — a background run knows it has nobody to talk to');
process.exit(0);
