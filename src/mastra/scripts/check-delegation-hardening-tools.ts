/**
 * P4 (delegation-depth-hardening) — checks for the small tool fixes.
 *
 *  - P4a: planSchema accepts steps WITHOUT expectedOutput (the exact live
 *    failure: a 3-step plan was rejected wholesale and meta lost persisted
 *    planning at `critical` depth).
 *  - P4c: Tavily site:-only queries are repaired instead of 400-ing.
 *
 * Run: npx tsx src/mastra/scripts/check-delegation-hardening-tools.ts
 */
import assert from 'node:assert/strict';

import { planSchema } from '../tools/system/plan-task.js';
import { repairSiteOnlyQuery } from '../tools/search/tavily.js';

// ── P4a: plan schema leniency ────────────────────────────────────────────────
// Live failure payload shape: every step missing expectedOutput.
const livePlanShape = {
  goal: 'Zaprojektować nowoczesną stronę Bistro Finnsson',
  assumptions: ['Strona finnssonbistro.is jest dostępna'],
  steps: [
    { id: 'step-1', intent: 'Research all site pages', toolOrAgent: 'researcherAgent', successCheck: 'Report contains full menu' },
    { id: 'step-2', intent: 'Design responsive HTML prototype', toolOrAgent: 'designAgent', successCheck: 'HTML file works on mobile' },
    { id: 'step-3', intent: 'Deliver file via Telegram', toolOrAgent: 'telegramSendFileTool', successCheck: 'User confirms receipt' },
  ],
  checkpoints: ['step-1'],
};

const parsed = planSchema.parse(livePlanShape);
assert.equal(parsed.steps.length, 3, 'all 3 steps should parse');
for (const step of parsed.steps) {
  assert.equal(typeof step.expectedOutput, 'string', `${step.id}: expectedOutput should default to a string`);
}

// A provided expectedOutput is preserved untouched.
const explicit = planSchema.parse({
  ...livePlanShape,
  steps: [{ id: 'step-1', intent: 'x', expectedOutput: 'research_report artifact', successCheck: 'y' }],
});
assert.equal(explicit.steps[0].expectedOutput, 'research_report artifact');

// ── P4c: Tavily site:-only query repair ──────────────────────────────────────
// The live 400: "Query cannot consist only of site: operators".
assert.equal(
  repairSiteOnlyQuery('site:finnssonbistro.is'),
  'site:finnssonbistro.is finnssonbistro',
  'site-only query should get the domain name appended as a term',
);
assert.equal(
  repairSiteOnlyQuery('site:www.example.com'),
  'site:www.example.com example',
  'www. prefix should be stripped from the appended term',
);
// Queries that already have terms pass through untouched.
assert.equal(repairSiteOnlyQuery('site:example.com menu prices'), 'site:example.com menu prices');
assert.equal(repairSiteOnlyQuery('best steak Reykjavik'), 'best steak Reykjavik');

// ── Self-delegation: ONE rule, replacing six hand-written per-agent guards ───
// Those six named `automationArchitect`, `knowledgeAgent`, `designAgent`,
// `writerAgent`, `filmmakerAgent` and `musicianAgent`, had no gate over any of
// them, and omitted every other agent — `codingAgent` was about to become a
// seventh copy. Asserted as a pure predicate because the tool's `execute` needs
// a Mastra instance to reach, which is why the previous version went untested.
const { isSelfDelegation } = await import('../config/agent-ids.js');

// The spellings that actually meet at this boundary: the caller identity is
// stamped by the RUN as a runtime id, the target is typed by the MODEL as an
// Agent Board id. Comparing them directly is how every self-delegation gets in.
assert.equal(isSelfDelegation('coding-agent', 'codingAgent'), true,
  'runtime id vs board id is the real pair — it must still be caught');
assert.equal(isSelfDelegation('codingAgent', 'codingAgent'), true);
assert.equal(isSelfDelegation('automation-architect', 'automationArchitect'), true);
assert.equal(isSelfDelegation('writer-agent', 'writerAgent'), true);

// Real delegation must stay possible, including the two the owner asked for.
assert.equal(isSelfDelegation('coding-agent', 'researcherAgent'), false);
assert.equal(isSelfDelegation('coding-agent', 'deliberationAgent'), false);
assert.equal(isSelfDelegation('coding-agent', 'codeReviewAgent'), false);

// An unknown caller is not an excuse to block: a missing identity means the run
// did not stamp one, and refusing every delegation then would be worse than the
// loop this guards against.
assert.equal(isSelfDelegation(undefined, 'codingAgent'), false);
assert.equal(isSelfDelegation('coding-agent', undefined), false);

console.log('DelegationHardening tool checks passed.');
