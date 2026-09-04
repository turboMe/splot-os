#!/usr/bin/env tsx
/**
 * F5B increment 2 — the model-backed lane decider.
 *
 * This is the first place a MODEL gets a say inside the orchestration boundary,
 * so the tests are about the trust boundary rather than the happy path. The
 * model is treated as untrusted input at every step:
 *
 *  - its framing is read leniently (models wrap JSON in prose no matter what the
 *    prompt says), but its CONTENT faces the strict validator, so leniency about
 *    framing can never widen what is accepted;
 *  - a decision carrying authority (taskId/fence/planVersion…) is rejected;
 *  - a timeout, an empty answer, garbage, or a runaway response all raise, and
 *    the activation degrades deterministically rather than acting on nonsense.
 *
 * Uses a scripted fake `ModelCaller`, so every adversarial response is exact and
 * the check is fast and deterministic.
 *
 * Run: npx tsx src/mastra/scripts/check-lane-decider-model.ts
 */
import assert from 'node:assert/strict';

import {
  createModelLaneDecider,
  extractDecisionJson,
  buildDecisionPrompt,
  LaneDecisionUnavailableError,
} from '../orchestration/execution/lane-decider.js';
import { InvalidLaneDecisionError, type LaneDecisionContext } from '../orchestration/contracts/lane-decision.js';

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

function context(overrides: Partial<LaneDecisionContext> = {}): LaneDecisionContext {
  return {
    jobId: 'job_test',
    goal: 'summarize the quarterly report',
    planVersion: 1,
    hasTasks: false,
    businessOperationCutoffAt: new Date(Date.now() + 20_000),
    ...overrides,
  };
}

/** A scripted model: returns exactly this text, optionally after a delay. */
function saying(text: string, delayMs = 0) {
  return async ({ signal }: { prompt: string; signal: AbortSignal }) => {
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
    }
    return { text };
  };
}

console.log('check:lane-decider-model');

await check('a clean decision is accepted', async () => {
  const decide = createModelLaneDecider({ callModel: saying('{"kind":"dispatch","attemptMode":"SERIAL"}') });
  assert.deepEqual(await decide(context()), { kind: 'dispatch', attemptMode: 'SERIAL' });
});

await check('every decision kind survives the round trip', async () => {
  const cases = [
    '{"kind":"dispatch","attemptMode":"SERIAL","taskGoal":"read the report first"}',
    '{"kind":"plan_steps","steps":[{"goal":"research"},{"goal":"write"}]}',
    '{"kind":"wait","reason":"an attempt is already running"}',
    '{"kind":"request_user","question":"Which quarter?"}',
    '{"kind":"synthesize","summary":"Revenue grew 4%."}',
    '{"kind":"terminalize","outcome":"COMPLETED"}',
  ];
  for (const text of cases) {
    const decide = createModelLaneDecider({ callModel: saying(text) });
    const decision = await decide(context());
    assert.equal(decision.kind, JSON.parse(text).kind);
  }
});

await check('prose and code fences around the JSON are tolerated', async () => {
  // Not aspirational tidiness: models do this constantly, and failing on framing
  // would make the lane degrade for a decision that was actually fine.
  const wrapped = [
    'Sure! Here is my decision:\n```json\n{"kind":"dispatch","attemptMode":"SERIAL"}\n```',
    'I think we should dispatch. {"kind":"dispatch","attemptMode":"SERIAL"} Hope that helps!',
    '```\n{"kind":"dispatch","attemptMode":"SERIAL"}\n```',
  ];
  for (const text of wrapped) {
    const decide = createModelLaneDecider({ callModel: saying(text) });
    assert.equal((await decide(context())).kind, 'dispatch');
  }
});

await check('nested braces and braces inside strings are parsed correctly', async () => {
  const decision = extractDecisionJson('noise {"kind":"wait","reason":"waiting for {something}"} more noise');
  assert.deepEqual(decision, { kind: 'wait', reason: 'waiting for {something}' });
});

await check('SECURITY: a model claiming authority is rejected, not stripped', async () => {
  // The core threat: the model emits a taskId/fence hoping it will be honoured.
  for (const forbidden of ['taskId', 'fence', 'planVersion', 'activationId', 'jobId']) {
    const decide = createModelLaneDecider({
      callModel: saying(`{"kind":"dispatch","attemptMode":"SERIAL","${forbidden}":"pwned"}`),
    });
    await assert.rejects(
      () => decide(context()),
      (error: unknown) => error instanceof InvalidLaneDecisionError,
      `a decision carrying ${forbidden} must be rejected`,
    );
  }
});

await check('SECURITY: a model cannot invent fan-out', async () => {
  const decide = createModelLaneDecider({
    callModel: saying('{"kind":"dispatch","attemptMode":"PARALLEL"}'),
  });
  await assert.rejects(() => decide(context()), (e: unknown) => e instanceof InvalidLaneDecisionError);
});

await check('garbage, empty and runaway responses all raise rather than guess', async () => {
  const bad: Array<[string, string]> = [
    ['', 'empty response'],
    ['I am not sure what to do here.', 'prose with no JSON'],
    ['{"kind":"dispatch",', 'truncated JSON'],
    ['{not json at all}', 'unparseable braces'],
    [`{"kind":"wait","reason":"${'x'.repeat(5_000)}"}`, 'runaway response'],
  ];
  for (const [text, why] of bad) {
    const decide = createModelLaneDecider({ callModel: saying(text) });
    await assert.rejects(
      () => decide(context()),
      (error: unknown) =>
        error instanceof LaneDecisionUnavailableError || error instanceof InvalidLaneDecisionError,
      `must raise for ${why}`,
    );
  }
});

await check('the activation window bounds the model — a slow decider does not outlive it', async () => {
  // "Each lane activation is short" (§4.2) has to be structural. The cutoff is
  // the same instant after which the decision could not be frozen anyway.
  const decide = createModelLaneDecider({ callModel: saying('{"kind":"dispatch","attemptMode":"SERIAL"}', 30_000) });
  const startedAt = Date.now();
  await assert.rejects(
    () => decide(context({ businessOperationCutoffAt: new Date(Date.now() + 700) })),
    (error: unknown) => error instanceof LaneDecisionUnavailableError,
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 10_000, `must be cut at the window, took ${elapsedMs}ms`);
});

await check('an already-expired window never even calls the model', async () => {
  let called = false;
  const decide = createModelLaneDecider({
    callModel: async () => { called = true; return { text: '{"kind":"dispatch","attemptMode":"SERIAL"}' }; },
  });
  await assert.rejects(() => decide(context({ businessOperationCutoffAt: new Date(Date.now() - 1) })));
  assert.equal(called, false, 'fail-before-work: no point starting a call that cannot be committed');
});

await check('CANARY REGRESSION: the evaluate prompt differs from the plan prompt', async () => {
  // Both questions once shared one prompt, so the judge never knew it was
  // judging and answered "dispatch" every time — every job burned its whole
  // replan budget before the bound stopped it. Found on the first real job.
  const planPrompt = buildDecisionPrompt(context({ reason: 'plan' }));
  const evalPrompt = buildDecisionPrompt(context({
    reason: 'evaluate',
    taskPhases: ['SUCCEEDED'],
    taskCount: 1,
    lastResult: { status: 'ok', text: 'MongoDB replica sets replicate data across nodes.' },
  }));
  assert.notEqual(planPrompt, evalPrompt, 'the judge must be told which question it is answering');
  assert.match(evalPrompt, /FINISHED/, 'the evaluate prompt must say the work is done');
  assert.match(evalPrompt, /terminalize/, 'and must offer finishing as the default');
});

await check('CANARY REGRESSION: the judge is shown what the work produced', async () => {
  // Judging "is this good enough" from task phases alone is impossible, so the
  // judge could only ever retry. §4.2 asks it to evaluate results AND EVIDENCE.
  const prompt = buildDecisionPrompt(context({
    reason: 'evaluate',
    taskPhases: ['SUCCEEDED'],
    taskCount: 1,
    lastResult: { status: 'ok', text: 'REPLICA_SET_SUMMARY_MARKER' },
  }));
  assert.match(prompt, /REPLICA_SET_SUMMARY_MARKER/, 'the actual output must reach the judge');
  assert.match(prompt, /status: ok/, 'along with its status');
});

await check('CANARY REGRESSION: the judge may send the job to the user, and knows what it was told', async () => {
  // chefAgent answered "which cuisine? any dietary limits?" and the job closed
  // COMPLETED with a question as its deliverable. Retrying only asks again — the
  // judge needs a third option, and needs to see the answer once it arrives, or
  // it re-asks forever.
  const prompt = buildDecisionPrompt(context({
    reason: 'evaluate',
    taskPhases: ['SUCCEEDED'],
    taskCount: 1,
    lastResult: { status: 'ok', text: 'Which cuisine did you have in mind?' },
    instructions: ['User answer: Polish, seasonal'],
    questionsAsked: 1,
  }));
  assert.match(prompt, /request_user/, 'asking the user must be an offered decision');
  assert.match(prompt, /Polish, seasonal/, 'the answer already given must be visible to the judge');
  assert.match(prompt, /already asked the user 1/, 'and so must the number of questions spent');
});

await check('GAP-PLAN-STEPS-01: the plan prompt OFFERS a sequence, and the evaluate prompt does not', async () => {
  // The F6B machinery was complete and unreachable. `plan_steps` had a contract,
  // a validator, a store path committing it, `materializePlannedSteps` and
  // `promoteSequencedSteps` called from the LIVE lane, and a 17-assertion gate —
  // and no prompt anywhere told a model the decision existed. `grep plan_steps`
  // found the contract, the store and the test, and nothing that produces one.
  // The gate was green because it built the decision by hand, which proves the
  // store executes a sequence, not that anything ever asks for one.
  //
  // So this asserts the LINK, from both ends, and asserts the boundary too:
  // at evaluate time FINAL_DECISION cannot execute `plan_steps` and falls
  // through to terminalize, which would finish a job on a decision that means
  // "there is more to do".
  const planPrompt = buildDecisionPrompt(context({ reason: 'plan' }));
  assert.match(planPrompt, /plan_steps/, 'starting a job must offer a sequence, or F6B is dead code');
  assert.match(planPrompt, /dispatch/, 'and must still offer the single-task shape it prefers');

  const evalPrompt = buildDecisionPrompt(context({
    reason: 'evaluate',
    taskPhases: ['SUCCEEDED'],
    taskCount: 1,
    lastResult: { status: 'ok', text: 'done' },
  }));
  assert.ok(
    !evalPrompt.includes('plan_steps'),
    'the judge must NOT be offered a sequence: FINAL_DECISION cannot execute one and would terminalize instead',
  );
});

await check('GAP-PLAN-STEPS-01: the agent instructions carry the same decision', async () => {
  // The decider prompt is the question; `prompts/lane-orchestrator/base.md` is
  // the vocabulary. A decision offered by one and not the other is the drift
  // that made this gap in the first place, so both ends are pinned.
  const { loadPrompt } = await import('../lib/prompt-loader.js');
  const instructions = await loadPrompt('lane-orchestrator/base');
  assert.match(instructions, /plan_steps/, 'the orchestrator must know the decision exists');
  assert.match(
    instructions,
    /"goal"/,
    'and must know the step shape, since a step carrying anything else is rejected outright',
  );
});

await check('GAP-PLAN-STEPS-01: a model-shaped sequence survives parse and validation', async () => {
  // End to end at this seam: raw model text → extracted JSON → strict validator.
  // Not a hand-built object, because the hand-built object is exactly what hid
  // the gap.
  const decide = createModelLaneDecider({
    callModel: saying(
      'Sure, here is the plan:\n```json\n'
      + '{"kind":"plan_steps","steps":['
      + '{"goal":"Research the supplier landscape","capability":"researcherAgent"},'
      + '{"goal":"Write the report","capability":"writerAgent"}]}\n```',
    ),
  });
  // The menu must be offered: a plan's steps are roster-checked exactly like a
  // dispatch now. It was not, and the asymmetry was invisible rather than
  // intended — a plan could name a specialist that had never been on the menu,
  // survive the boundary, be frozen into durable state, and fail at execution as
  // `no_route` after the plan had already spent the job's task budget.
  const offered = [
    { name: 'researcherAgent', description: 'research' },
    { name: 'writerAgent', description: 'writing' },
  ];
  assert.deepEqual(await decide(context({ reason: 'plan', capabilities: offered })), {
    kind: 'plan_steps',
    steps: [
      { goal: 'Research the supplier landscape', capability: 'researcherAgent' },
      { goal: 'Write the report', capability: 'writerAgent' },
    ],
  });
});

await check('a plan naming a specialist that was never offered is REJECTED', async () => {
  const decide = createModelLaneDecider({
    callModel: saying(
      '{"kind":"plan_steps","steps":['
      + '{"goal":"a","capability":"filmmakerAgent"},{"goal":"b","capability":"writerAgent"}]}',
    ),
  });
  await assert.rejects(
    () => decide(context({ reason: 'plan', capabilities: [{ name: 'writerAgent', description: 'writing' }] })),
    InvalidLaneDecisionError,
  );
});

await check('a plan is repaired when a step duplicates work the next capability runs itself', async () => {
  // The measured failure, at the seam where it can be corrected. `chefAgent`
  // delegates its own recon to `researcherAgent` under a JSON contract its
  // importer reads; a research step in front of it produced prose the importer
  // could not use, and the planner's step goal no longer carried the URL that
  // chef's recon branch keys on.
  const menu = [
    { name: 'researcherAgent', description: 'research' },
    { name: 'chefAgent', description: 'menus', runsInternally: ['researcherAgent'] },
  ];
  const decide = createModelLaneDecider({
    callModel: saying(
      '{"kind":"plan_steps","steps":['
      + '{"goal":"Przeanalizuj ofertę restauracji","capability":"researcherAgent"},'
      + '{"goal":"Zaprojektuj nowe menu","capability":"chefAgent"}]}',
    ),
  });
  const decision = await decide(context({ reason: 'plan', capabilities: menu }));
  // Collapsed to ONE dispatch — and carrying no taskGoal, which is the half that
  // actually matters: a task with no goal of its own inherits the job goal and
  // the worker hands it over byte for byte, URL included.
  assert.deepEqual(decision, { kind: 'dispatch', attemptMode: 'SERIAL', capability: 'chefAgent' });
});

await check('repair keeps the steps a plan got right', async () => {
  // researcher → chef → writer is two decisions in one: the research step is
  // redundant, the articles step is real work. Dropping the whole plan would
  // lose the articles; measured against job_b1fdfde6, which asked for a menu AND
  // three newspaper pieces.
  const menu = [
    { name: 'researcherAgent', description: 'research' },
    { name: 'chefAgent', description: 'menus', runsInternally: ['researcherAgent'] },
    { name: 'writerAgent', description: 'long-form', runsInternally: ['researcherAgent'] },
  ];
  const decide = createModelLaneDecider({
    callModel: saying(
      '{"kind":"plan_steps","steps":['
      + '{"goal":"research trends","capability":"researcherAgent"},'
      + '{"goal":"design the menu","capability":"chefAgent"},'
      + '{"goal":"write three articles","capability":"writerAgent"}]}',
    ),
  });
  assert.deepEqual(await decide(context({ reason: 'plan', capabilities: menu })), {
    kind: 'plan_steps',
    steps: [
      { goal: 'design the menu', capability: 'chefAgent' },
      { goal: 'write three articles', capability: 'writerAgent' },
    ],
  });
});

await check('repair leaves a genuinely cross-domain plan alone', async () => {
  // chef → writer names two specialists and neither runs the other. A repair
  // that fired here would be worse than the defect it fixes.
  const menu = [
    { name: 'chefAgent', description: 'menus', runsInternally: ['researcherAgent'] },
    { name: 'writerAgent', description: 'long-form', runsInternally: ['researcherAgent'] },
  ];
  const decide = createModelLaneDecider({
    callModel: saying(
      '{"kind":"plan_steps","steps":['
      + '{"goal":"design the menu","capability":"chefAgent"},'
      + '{"goal":"write three articles","capability":"writerAgent"}]}',
    ),
  });
  const decision = await decide(context({ reason: 'plan', capabilities: menu }));
  assert.equal(decision.kind, 'plan_steps');
  assert.equal((decision as { steps: unknown[] }).steps.length, 2);
});

await check('GAP-PLAN-STEPS-01: a step that claims a budget or an id is rejected', async () => {
  // The same authority rule as the decision itself. A step is intent only.
  const decide = createModelLaneDecider({
    callModel: saying(
      '{"kind":"plan_steps","steps":['
      + '{"goal":"a","capability":"researcherAgent","attemptCapMs":999999},'
      + '{"goal":"b"}]}',
    ),
  });
  await assert.rejects(() => decide(context({ reason: 'plan' })), InvalidLaneDecisionError);
});

await check('the prompt states the goal and never leaks identifiers into it', async () => {
  const prompt = buildDecisionPrompt(context({ goal: 'summarize the quarterly report' }));
  assert.match(prompt, /summarize the quarterly report/);
  assert.ok(!prompt.includes('job_test'), 'the jobId must not be shown — the model has no use for it and must not echo it back');
});

if (failures > 0) {
  console.error(`\n❌ check:lane-decider-model — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:lane-decider-model — the model proposes, the boundary disposes: bounded, parsed strictly, authority-free');
process.exit(0);
