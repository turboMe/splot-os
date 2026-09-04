#!/usr/bin/env tsx
/**
 * K3 — an agent with a dedicated legacy harness must not LOSE its domain
 * precontext when it runs on V2.
 *
 * V2 hands every capability the same generic harness: depth, reflector, step
 * ceiling, liveness, tool envelopes, attempt budget. For the agents that came
 * from a bare `agent.generate` that is a clear upgrade. For the four with a
 * dedicated harness it was a REGRESSION — `harness-agent-caller` passed no
 * `contextBuilder`, so an automation run on V2 could not see which credentials
 * exist, which patterns had worked, or which failures were already diagnosed.
 *
 * WHAT IS FAKED AND WHY
 * ---------------------
 * Only the AGENT — the external boundary that would otherwise call a model. The
 * caller, the harness, the registry and the precontext plumbing are all real, so
 * this proves the wiring rather than restating it. Three defects in this project
 * hid behind a test double placed one layer too deep (`findArtifactIds`,
 * `readResult`, `consumeApproval`), and the rule since then is: when a test names
 * a piece of logic, that logic must actually execute in it.
 *
 * Nothing else is stubbed — not even the precontext builder. An earlier draft
 * tried to swap it at its module boundary and ESM refused, which turned out to be
 * the better outcome: the real builder emits `## Automation Passive Context` and
 * its section headers unconditionally, so asserting on those proves the genuine
 * article ran and arrived, with no stand-in to be wrong about.
 *
 * Run: npx tsx src/mastra/scripts/check-capability-precontext.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { Agent } from '@mastra/core/agent';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

console.log('check:capability-precontext');

/** Emitted unconditionally by the real builder — its presence IS the proof. */
const PRECONTEXT_HEADER = '## Automation Passive Context';
const CREDENTIALS_SECTION = '### Credential Registry';

const { precontextForCapability, CAPABILITIES_WITH_PRECONTEXT } = await import(
  '../orchestration/execution/capability-precontext.js'
);

// ── 1. The registry ────────────────────────────────────────────────────────
await check('automationArchitect has a precontext; a generic agent has none', async () => {
  assert.ok(CAPABILITIES_WITH_PRECONTEXT.includes('automationArchitect'));
  const generic = await precontextForCapability('designAgent');
  assert.deepEqual(generic, {},
    'a capability without a precontext must produce an UNCHANGED harness call');
});

await check('the V2 entry is the SAME object legacy spreads, not a copy', async () => {
  // The anti-drift assertion. Two hand-maintained copies of these four fields
  // would be free to diverge silently, which is precisely how the artifact
  // reference channel stayed broken: each end remembered the shape its own way.
  const { automationPrecontextFields } = await import('../services/automation-harness.js');
  const fromRegistry = await precontextForCapability('automationArchitect');
  assert.equal(fromRegistry, automationPrecontextFields,
    'identity, not deep equality — a copy would pass a deep check and still drift');
  assert.equal(automationPrecontextFields.precontextFeatureFlag, 'FEATURE_AUTOMATION_PRECONTEXT');
  assert.equal(automationPrecontextFields.precontextDefaultEnabled, true,
    'legacy has it on by default; V2 must not quietly run with it off');
});

// ── 2. The V2 caller actually uses it ──────────────────────────────────────
class FakeAgent {
  prompts: string[] = [];
  async generate(prompt: string, options: Record<string, any> = {}): Promise<unknown> {
    // The harness passes context as messages or prompt depending on shape; both
    // are captured so the assertion does not depend on that detail.
    this.prompts.push(`${prompt}\n${JSON.stringify(options.context ?? '')}`);
    return { text: 'gotowe', steps: [], finishReason: 'stop', toolCalls: [], toolResults: [] };
  }
}

async function runCapability(agentId: string): Promise<FakeAgent> {
  const { harnessCallerFactory } = await import(
    '../orchestration/execution/harness-agent-caller.js'
  );
  const agent = new FakeAgent();
  const now = Date.now();
  const caller = harnessCallerFactory({
    agent: agent as unknown as Agent,
    agentId,
    ctx: {
      attemptId: `att-${agentId}-${now}`,
      taskId: `task-${now}`,
      jobId: `job-${now}`,
      attemptNumber: 1,
      businessOperationCutoffAt: new Date(now + 600_000),
      workDeadlineAt: new Date(now + 540_000),
      hardDeadlineAt: new Date(now + 900_000),
      goal: 'zbuduj workflow n8n: webhook → walidacja → zapis',
    } as never,
  } as never);
  await caller({
    prompt: 'zbuduj workflow n8n: webhook → walidacja → zapis',
    signal: new AbortController().signal,
  });
  return agent;
}

await check('LIVE WIRING: the automation precontext reaches the model on V2', async () => {
  // The assertion that was false for every automation run before the registry
  // existed: V2 computed depth, reflector and liveness for this agent and handed
  // it a prompt with none of its operational facts in front.
  const agent = await runCapability('automationArchitect');
  const withContext = agent.prompts.find((p) => p.includes(PRECONTEXT_HEADER));
  assert.ok(withContext,
    'the real precontext must be built AND reach the agent, not merely be computed');
  assert.ok(withContext.includes(CREDENTIALS_SECTION),
    'and carry its content — the credential registry is the part a build cannot work without');
  assert.ok(
    withContext.indexOf(PRECONTEXT_HEADER) < withContext.indexOf('zbuduj workflow'),
    'context first, then the task: the harness prepends it before the goal',
  );
});

await check('a capability without a precontext still runs, and gets none', async () => {
  const agent = await runCapability('designAgent');
  assert.ok(agent.prompts.length > 0, 'the run must still happen');
  assert.ok(!agent.prompts.some((p) => p.includes(PRECONTEXT_HEADER)),
    'a generic capability must produce an UNCHANGED call — no foreign context leaks in');
});

// ── 3. codingAgent: the same wiring, plus the field its builder cannot work without
await check('codingAgent shares ONE precontext object with its legacy harness', async () => {
  const { codingPrecontextFields } = await import('../services/coding-harness.js');
  const fromRegistry = await precontextForCapability('codingAgent');
  assert.equal(fromRegistry, codingPrecontextFields,
    'identity, not deep equality — a copy would pass a deep check and still drift');
  assert.equal(codingPrecontextFields.precontextFeatureFlag, 'FEATURE_CODING_PRECONTEXT');
});

await check('codingAgent carries a repoPath — without it the precontext is half a precontext', async () => {
  // `buildCodingPrecontext` reads the repository map and the task checkpoint
  // THROUGH `repoPath`; with none it pushes `repoPath_missing` and returns only
  // memory and skills. Every legacy call site passes it explicitly and V2 has no
  // call site to do that, so it has to travel with the registry entry — which is
  // the whole reason this field is in `CapabilityPrecontextFields` at all.
  const { codingPrecontextFields } = await import('../services/coding-harness.js');
  const { AGENTIC_AGENTS_REPO } = await import('../workspaces/code-workspace.js');
  assert.equal(codingPrecontextFields.repoPath, AGENTIC_AGENTS_REPO,
    'the coding capability must default to the agent\'s own repository');

  const { buildCodingPrecontext } = await import('../services/coding-precontext.js');
  const withoutRepo = await buildCodingPrecontext({ userPrompt: 'fix the failing check' });
  assert.ok(withoutRepo.suppressedReasons.includes('repoPath_missing'),
    'the builder must SAY it dropped sections, or a silent half-precontext looks like a full one');
  assert.equal(withoutRepo.repoMapIncluded, false);
  assert.equal(withoutRepo.checkpointIncluded, false);
});

// ── 4. codeReviewAgent: the reviewer runs as its own V2 task ────────────────
await check('codeReviewAgent shares ONE precontext object with its legacy harness', async () => {
  // The reviewer is a SEPARATE V2 task with its own run (proven live:
  // codingAgent → codeReviewAgent), and V2 never calls `generateReview`. So it
  // reviewed from the brief alone: no diff, no changed files, no verification
  // signals, no earlier review notes — and nothing said so. A review with less
  // to go on still produces a confident verdict, which is what makes this
  // expensive rather than merely missing.
  const { reviewPrecontextFields } = await import('../services/review-harness.js');
  const fromRegistry = await precontextForCapability('codeReviewAgent');
  assert.equal(fromRegistry, reviewPrecontextFields,
    'identity, not deep equality — a copy would pass a deep check and still drift');
  assert.equal(reviewPrecontextFields.precontextFeatureFlag, 'FEATURE_REVIEW_PRECONTEXT');
  assert.equal(reviewPrecontextFields.precontextDefaultEnabled, true,
    'legacy has it on by default; V2 must not be quietly stricter');
});

await check('the legacy review path spreads the SAME object, so the two cannot drift', () => {
  const src = readFileSync('src/mastra/services/review-harness.ts', 'utf-8');
  assert.match(src, /\.\.\.reviewPrecontextFields,/,
    'generateReview must spread the shared object rather than restate the flags');
});

// ── 5. securityReviewAgent / performanceReviewAgent: same generic reviewer
// harness as codeReviewAgent (`buildReviewPrecontext` keys off the runtime
// `agentId`, not a hardcoded reviewer) — legacy already treats all three
// identically, so a registry entry missing for either of these two is the
// exact regression §2 of the V2 rollout was written to prevent.
for (const reviewerId of ['securityReviewAgent', 'performanceReviewAgent']) {
  await check(`${reviewerId} shares ONE precontext object with its legacy harness`, async () => {
    const { reviewPrecontextFields } = await import('../services/review-harness.js');
    const fromRegistry = await precontextForCapability(reviewerId);
    assert.equal(fromRegistry, reviewPrecontextFields,
      'identity, not deep equality — a copy would pass a deep check and still drift');
  });
}

await check('a capability with no precontext is not quoted a context budget', async () => {
  // `contextBudgetTokens` has ONE consumer: the precontext builder. An agent
  // without one has no enforced budget — but the depth header printed the number
  // anyway, so a chefAgent run read "Context budget: 4000 tokens" while its real
  // bound was its own 120k token limiter, and rationed itself against a figure
  // nothing checks. Same class as the `Max steps: 10` beside it: a limit that
  // exists only as a sentence in the prompt is not a limit, it is an
  // instruction.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('src/mastra/services/generate-with-harness.ts', 'utf8');
  assert.match(
    source,
    /const contextBudgetApplies = precontextEnabled && Boolean\(input\.contextBuilder\)/,
    'the header must be able to tell an enforced budget from an inert one',
  );
  assert.match(
    source,
    /\.\.\.\(contextBudgetApplies \? \{ effectiveContextMaxTokens \} : \{\}\)/,
    'and must pass the budget to the header ONLY when a builder consumed it',
  );
  assert.match(
    source,
    /\.\.\.\(runtime\.effectiveContextMaxTokens !== undefined\s*\?\s*\[`Context budget: /,
    'so the line disappears rather than quoting an unenforced number',
  );

  // The agents that DO have one keep it — this removes a false statement, not a
  // real budget.
  const withBuilder = await precontextForCapability('codingAgent');
  assert.ok('contextBuilder' in withBuilder,
    'codingAgent still supplies a builder, so its budget is still enforced and still shown');
  assert.deepEqual(await precontextForCapability('chefAgent'), {},
    'and chefAgent still has none — the fix is the header, not a new precontext');
});

console.log(failures === 0 ? '\nOK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
