#!/usr/bin/env tsx
/**
 * Capability → agent routing (plan Fala 6-8) — the lane picks the specialist.
 *
 * Before this, `singleAgentRoute` sent every job to one fixed agent: the lane
 * could decide *whether* to work, never *who* works. The risk of fixing that is
 * obvious — a model now influences which agent runs, and agents differ in what
 * they can spend and break. So the tests are about the choice being CLOSED and
 * DURABLE, not about a classifier being clever:
 *
 *  1. the menu is code-owned: unknown names, unavailable agents and a wide-open
 *     `*` all resolve through the same registry, and nothing outside it routes;
 *  2. a model naming a capability it was never offered is REJECTED, not dropped
 *     — the fallback path then routes to the default WITH an operator alert;
 *  3. the choice is frozen into the plan, so a restart, a retry or a second
 *     process reaches the same specialist;
 *  4. a capability that stops resolving (narrower allowlist, agent unregistered)
 *     FAILS the attempt visibly instead of silently running the wrong expert.
 *
 * Part 1 is deterministic; part 2 drives a real replica set and SKIPs without one.
 *
 * Run: npx tsx src/mastra/scripts/check-capability-routing.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  buildCapabilityRegistry,
  parseCapabilityAllowlist,
  DEFAULT_V2_CAPABILITIES,
} from '../config/capability-routing.js';
import { agentBoard } from '../config/agent-board.js';
import { PIPELINE_PHASE_TOOLS } from '../config/pipeline-phase-tools.js';
import { capabilityRoute, createRegistryWorker } from '../orchestration/execution/registry-worker.js';
import { createModelLaneDecider, buildDecisionPrompt } from '../orchestration/execution/lane-decider.js';
import { InvalidLaneDecisionError, assertLaneDecision } from '../orchestration/contracts/lane-decision.js';
import type { LaneDecisionContext } from '../orchestration/contracts/lane-decision.js';
import type { WorkerContext } from '../orchestration/store/worker.js';
import type { TaskDoc } from '../orchestration/store/collections.js';
import { connectReplicaSetOrSkip } from './lib/replica-set.js';

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

const TEST_DATABASE = `cap_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;

function workerCtx(over: Partial<WorkerContext> = {}): WorkerContext {
  return {
    attemptId: 'att_1', taskId: 'tsk_1', jobId: 'job_1', attemptNumber: 1,
    businessOperationCutoffAt: new Date(Date.now() + 10_000),
    workDeadlineAt: new Date(Date.now() + 20_000),
    hardDeadlineAt: new Date(Date.now() + 30_000),
    goal: 'plan a tasting menu', instructions: [],
    ...over,
  };
}

function decisionCtx(over: Partial<LaneDecisionContext> = {}): LaneDecisionContext {
  return {
    jobId: 'job_1', goal: 'plan a tasting menu', planVersion: 1, hasTasks: false,
    businessOperationCutoffAt: new Date(Date.now() + 20_000),
    ...over,
  };
}

const saying = (text: string) => async () => ({ text });

console.log('check:capability-routing');

// ── 1. The registry ────────────────────────────────────────────────────────
await check('the vocabulary is the Agent Board — no second roster', () => {
  const registry = buildCapabilityRegistry({ allow: '*', defaultAgentId: 'researcherAgent' });
  const names = registry.entries.map((e) => e.capability).sort();
  assert.deepEqual(names, Object.keys(agentBoard).sort(),
    'a capability set that can drift from the board is the thing this must not become');
});

await check('every default capability is a real board card', () => {
  for (const name of DEFAULT_V2_CAPABILITIES) {
    assert.ok(name in agentBoard, `${name} is enabled by default but has no board card`);
  }
});

await check('SECURITY: a name outside the registry resolves to nothing', () => {
  const registry = buildCapabilityRegistry({ defaultAgentId: 'researcherAgent' });
  for (const bogus of ['metaAgent', 'codingAgent', 'chefagent', 'chefAgent ', '__proto__', 'toString']) {
    assert.equal(registry.resolve(bogus), null, `${bogus} must not resolve`);
  }
});

await check('an unavailable agent never reaches the menu', () => {
  // Offering a specialist this process cannot run means the lane names it, the
  // worker fails `agent_not_found`, and a job burns an attempt to discover
  // something the mount already knew.
  const registry = buildCapabilityRegistry({
    allow: '*',
    isAvailable: (id) => id !== 'chefAgent',
    defaultAgentId: 'researcherAgent',
  });
  assert.equal(registry.resolve('chefAgent'), null);
  assert.ok(!registry.forDecider().some((c) => c.name === 'chefAgent'));
});

await check('the decider menu carries the fields that say HOW to engage a capability', async () => {
  // The menu was a lossy projection of the board, and the loss decided a run.
  // chefAgent's card states three times that a menu job is ONE delegation and
  // that chef runs its own recon; none of that lives in oneLiner/whenToUse/
  // whenNotToUse, so the lane never saw it and split a menu job into
  // research → chef. The generic research came back as prose, chef's
  // `chef_import_website_profile` mapper only reads the Mission A JSON its own
  // recon brief asks for, and chef improvised for 30 minutes and timed out with
  // nothing to show.
  const registry = buildCapabilityRegistry({ allow: ['chefAgent', 'researcherAgent'] , defaultAgentId: 'researcherAgent' });
  const chef = registry.forDecider().find((c) => c.name === 'chefAgent');
  assert.ok(chef, 'chefAgent must be on the menu');

  // WHAT THIS CAN AND CANNOT PROVE.
  //
  // The previous version asserted the string `ALWAYS one chefAgent delegation`
  // and called it "the single fact that would have prevented the observed
  // split". The string was present and the split happened anyway, 5 runs out of
  // 5 on the live decider: both clauses of that rule were about WHO MAY WRITE
  // chef data, and a plan whose final step is a chefAgent delegation satisfies
  // them. A gate that checks for a string cannot notice that the string says
  // the wrong thing — so this one now asserts what the wording has to be ABOUT,
  // and the guarantee itself lives in `runsInternally` + `repairPlanOwnership`,
  // where it is structural and testable (`check:lane-decider-model`).
  assert.match(chef!.description, /never (put a research or analysis step in front of|split)/i,
    'the hard rule must forbid DECOMPOSING the capability, not merely reserve its writes — '
    + 'the write-ownership wording was present throughout the observed split');
  assert.match(chef!.description, /autonomously/i,
    'and the input contract that says chef runs recon itself');

  // Sparse by design: 4 of 21 cards carry hardRules, so the cost lands where it buys
  // something. A capability without them must not grow an empty label.
  const researcher = registry.forDecider().find((c) => c.name === 'researcherAgent');
  assert.ok(!/HARD RULES/.test(researcher!.description),
    'a card with no hard rules must not render an empty section');
  assert.match(researcher!.description, /Input:/,
    'but every card has an input contract, so that half is universal');
});

await check('every agent that delegates inside its own pipeline declares it as data', () => {
  // The words in `hardRules` persuade the planner; this field lets the lane
  // REPAIR the plans they did not prevent. Derived from the tool map so a new
  // pipeline phase that starts delegating cannot quietly go undeclared: the map
  // is edited when the phase is built, this card is not.
  const registry = buildCapabilityRegistry({ allow: '*', defaultAgentId: 'researcherAgent' });
  const menu = new Map(registry.forDecider().map((c) => [c.name, c]));
  const undeclared: string[] = [];
  for (const [agent, map] of Object.entries(PIPELINE_PHASE_TOOLS)) {
    const delegatesInAPhase = Object.values(map.phases)
      .some((tools) => tools.includes('system_delegate_task'));
    if (!delegatesInAPhase) continue;
    if ((menu.get(agent)?.runsInternally ?? []).length === 0) undeclared.push(agent);
  }
  assert.deepEqual(undeclared, [],
    'these agents delegate inside a pipeline phase but declare no `runsInternally`, so the '
    + 'lane cannot tell that a step in front of them duplicates work they already do — the '
    + 'exact shape that split every menu job naming a website');
});

await check('a capability never declares itself as its own internal delegate', () => {
  // A self-reference would make `repairPlanOwnership` drop a step in favour of
  // itself, which is either a no-op or a plan quietly losing work.
  const registry = buildCapabilityRegistry({ allow: '*', defaultAgentId: 'researcherAgent' });
  for (const entry of registry.entries) {
    assert.ok(!entry.runsInternally.includes(entry.capability),
      `${entry.capability} lists itself in runsInternally`);
  }
});

await check('the default target is always routable, even outside the allowlist', () => {
  const registry = buildCapabilityRegistry({ allow: ['chefAgent'], defaultAgentId: 'weatherAgent' });
  assert.equal(registry.resolve('weatherAgent'), 'weatherAgent', 'a job must always have somewhere to go');
});

await check('the allowlist parses: empty = conservative default, * = everything', () => {
  assert.deepEqual(parseCapabilityAllowlist(undefined), DEFAULT_V2_CAPABILITIES);
  assert.deepEqual(parseCapabilityAllowlist('  '), DEFAULT_V2_CAPABILITIES);
  assert.equal(parseCapabilityAllowlist('*'), '*');
  assert.deepEqual(parseCapabilityAllowlist('chefAgent, writerAgent'), ['chefAgent', 'writerAgent']);
});

await check('the default set excludes the agents that spend money or change the world', () => {
  // Not a style preference: the V2 flags are live, so the first wrong guess
  // happens in production. These are the ones where "wrong" is not just wasted.
  for (const dangerous of [
    'musicianAgent', 'filmmakerAgent', 'designAgent', 'codingAgent',
    'automationArchitect', 'huntAgent', 'salesAgent', 'capabilitySmith',
  ]) {
    assert.ok(!DEFAULT_V2_CAPABILITIES.includes(dangerous),
      `${dangerous} must be opt-in via ORCHESTRATION_V2_CAPABILITIES, not on by default`);
  }
});

// ── 2. The decision boundary ───────────────────────────────────────────────
await check('the menu reaches the planning prompt, and only the planning prompt', () => {
  const capabilities = [{ name: 'chefAgent', description: 'Menu engineering.' }];
  const plan = buildDecisionPrompt(decisionCtx({ capabilities }));
  assert.match(plan, /chefAgent: Menu engineering\./);
  assert.match(plan, /"capability"/, 'the prompt must say how to name one');
  const evaluate = buildDecisionPrompt(decisionCtx({
    capabilities, reason: 'evaluate', taskPhases: ['SUCCEEDED'],
    lastResult: { status: 'ok', text: 'done' },
  }));
  assert.ok(!evaluate.includes('chefAgent'), 'judging finished work is not a routing question');
});

await check('no menu means no routing question — the pre-routing prompt is unchanged', () => {
  const prompt = buildDecisionPrompt(decisionCtx());
  assert.ok(!prompt.includes('capability'), 'a mount without a registry must not invite a choice');
});

await check('an offered capability survives the round trip', async () => {
  const decide = createModelLaneDecider({
    callModel: saying('{"kind":"dispatch","attemptMode":"SERIAL","capability":"chefAgent"}'),
    capabilities: [{ name: 'chefAgent', description: 'Menu engineering.' }],
  });
  assert.deepEqual(await decide(decisionCtx()), {
    kind: 'dispatch', attemptMode: 'SERIAL', capability: 'chefAgent',
  });
});

await check('SECURITY: a capability that was never offered is rejected', async () => {
  const decide = createModelLaneDecider({
    callModel: saying('{"kind":"dispatch","attemptMode":"SERIAL","capability":"codingAgent"}'),
    capabilities: [{ name: 'chefAgent', description: 'Menu engineering.' }],
  });
  await assert.rejects(() => decide(decisionCtx()), (e: unknown) => e instanceof InvalidLaneDecisionError);
});

await check('SECURITY: capability is an identifier, never a payload', () => {
  for (const junk of [
    'chef Agent', 'chefAgent; rm -rf /', '../../etc/passwd', '', 'a'.repeat(65),
    '1chefAgent', { name: 'chefAgent' }, ['chefAgent'],
  ]) {
    assert.throws(
      () => assertLaneDecision({ kind: 'dispatch', attemptMode: 'SERIAL', capability: junk }),
      (e: unknown) => e instanceof InvalidLaneDecisionError,
      `${JSON.stringify(junk)} must not pass as a capability`,
    );
  }
});

await check('SECURITY: naming an agent directly is still not a thing a decision can do', () => {
  // The escape hatch a model would reach for if `capability` were validated but
  // `agentId` were merely ignored: an unknown key must be a hard error.
  assert.throws(
    () => assertLaneDecision({ kind: 'dispatch', attemptMode: 'SERIAL', capability: 'chefAgent', agentId: 'codingAgent' }),
    (e: unknown) => e instanceof InvalidLaneDecisionError,
  );
});

await check('a decision with no capability is still valid — "no preference" is an answer', async () => {
  const decide = createModelLaneDecider({
    callModel: saying('{"kind":"dispatch","attemptMode":"SERIAL"}'),
    capabilities: [{ name: 'chefAgent', description: 'Menu engineering.' }],
  });
  assert.deepEqual(await decide(decisionCtx()), { kind: 'dispatch', attemptMode: 'SERIAL' });
});

// ── 3. The router ──────────────────────────────────────────────────────────
await check('a task with no capability goes to the default', () => {
  const route = capabilityRoute({ resolve: () => null, defaultAgentId: 'researcherAgent' });
  assert.equal(route(workerCtx())?.agentId, 'researcherAgent');
});

await check('a task with a capability goes to that specialist', () => {
  const registry = buildCapabilityRegistry({ allow: '*', defaultAgentId: 'researcherAgent' });
  const route = capabilityRoute({ resolve: (n) => registry.resolve(n), defaultAgentId: 'researcherAgent' });
  assert.equal(route(workerCtx({ capability: 'chefAgent' }))?.agentId, 'chefAgent');
});

await check('headless instructions do not contaminate the semantic classification prompt', () => {
  const registry = buildCapabilityRegistry({ allow: '*', defaultAgentId: 'researcherAgent' });
  const route = capabilityRoute({
    resolve: (name) => registry.resolve(name),
    defaultAgentId: 'researcherAgent',
    deliverableFor: (name) => registry.deliverableFor(name),
  });
  const decision = route(workerCtx({
    capability: 'deliberationAgent',
    goal: 'Porównaj monolit i mikroserwisy.',
    jobGoal: 'Przeprowadź debatę architektoniczną.',
    taskGoal: 'Porównaj monolit i mikroserwisy.',
    instructions: ['Uwzględnij ograniczenia operacyjne.'],
  }));
  assert.ok(decision?.prompt.includes('--- HOW THIS RUN WORKS ---'));
  assert.ok(!decision?.classificationPrompt?.includes('--- HOW THIS RUN WORKS ---'));
  assert.ok(decision?.classificationPrompt?.includes('Przeprowadź debatę architektoniczną.'));
  assert.ok(decision?.classificationPrompt?.includes('Porównaj monolit i mikroserwisy.'));
  assert.ok(decision?.classificationPrompt?.includes('Uwzględnij ograniczenia operacyjne.'));
});

await check('a capability that no longer resolves FAILS rather than substituting', async () => {
  // The durable case: the plan was frozen when chefAgent was enabled; this
  // process has a narrower allowlist. Answering the user with the wrong expert
  // is worse than failing, because the answer would look fine.
  const narrow = buildCapabilityRegistry({ allow: ['researcherAgent'], defaultAgentId: 'researcherAgent' });
  const worker = createRegistryWorker({
    getAgent: () => ({ generate: async () => ({ text: 'should never run' }) }),
    route: capabilityRoute({ resolve: (n) => narrow.resolve(n), defaultAgentId: 'researcherAgent' }),
  });
  const result = await worker(workerCtx({ capability: 'chefAgent' })) as { status: string; error?: { code: string } };
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'no_route');
});

await check('the routed agent is the one actually invoked', async () => {
  const registry = buildCapabilityRegistry({ allow: '*', defaultAgentId: 'researcherAgent' });
  const invoked: string[] = [];
  const worker = createRegistryWorker({
    getAgent: (id) => { invoked.push(id); return { generate: async () => ({ text: 'menu' }) }; },
    route: capabilityRoute({ resolve: (n) => registry.resolve(n), defaultAgentId: 'researcherAgent' }),
  });
  await worker(workerCtx({ capability: 'writerAgent' }));
  assert.deepEqual(invoked, ['writerAgent']);
});

// ── 4. The attempt budget follows the capability ───────────────────────────
await check('LIVE REGRESSION: a long-latency specialist gets a longer window', () => {
  // One constant for everyone was not a simplification: the V2 window measured
  // 296s and chefAgent (latencyClass: long) was cut before producing ANY text,
  // so every attempt failed empty and the job ended FAILED.
  const registry = buildCapabilityRegistry({ allow: '*', defaultAgentId: 'researcherAgent' });
  const chef = registry.attemptCapMsFor('chefAgent');
  const crm = registry.attemptCapMsFor('crmAgent');
  const writer = registry.attemptCapMsFor('writerAgent');
  const writerProgressive = registry.progressiveAttemptPolicyFor('writerAgent');
  assert.ok(chef && chef > 300_000, `chefAgent is latencyClass:long, got ${chef}ms`);
  assert.ok(crm && crm < chef, 'a quick lookup must not hold a long window');
  assert.equal(writer, 2_700_000, 'Writer freezes the absolute 45-minute ceiling');
  assert.deepEqual(writerProgressive, {
    initialWindowMs: 900_000,
    extensionMs: 300_000,
    extensionLeadMs: 480_000,
    maxCapMs: 2_700_000,
    maxExtensions: 6,
  });
});

await check('an unknown capability falls back to the store default, not to nothing', () => {
  const registry = buildCapabilityRegistry({ defaultAgentId: 'researcherAgent' });
  assert.equal(registry.attemptCapMsFor('nonesuch'), undefined, 'unknown resolves nowhere');
  assert.ok((registry.attemptCapMsFor(null) ?? 0) > 0, 'no preference still gets a window');
});

// ── 5. Durability: the choice is frozen into the plan ──────────────────────
const {
  ensureOrchestrationIndexes, acceptStartCommand,
  runLaneForJob, drainWorkers, COLLECTIONS,
} = await import('../orchestration/store/index.js');

const store = await connectReplicaSetOrSkip({
  dbName: TEST_DATABASE,
  section: 'check:capability-routing durability section',
});

if (store) {
  const { client, db } = store;
  await ensureOrchestrationIndexes(db);
  let seq = 0;
  const newJob = async (goal: string): Promise<string> => {
    seq++;
    const accepted = await acceptStartCommand(client, db, {
      resourceId: 'res_cap', conversationId: `conv_${seq}`, goal,
      commandId: `cmd_${randomUUID()}`, payload: { goal },
    });
    return accepted.jobId;
  };
  const chefDecider = (async (ctx: { reason?: string }) => (
    ctx.reason === 'evaluate'
      ? { kind: 'terminalize', outcome: 'COMPLETED' }
      : { kind: 'dispatch', attemptMode: 'SERIAL', capability: 'chefAgent', taskGoal: 'design the menu' }
  )) as never;

  await check('the lane freezes the chosen specialist onto the task', async () => {
    const jobId = await newJob('plan a tasting menu');
    await runLaneForJob(client, db, jobId, 50, undefined, { decide: chefDecider } as never);
    const task = await db.collection<{ capability?: string | null; goal?: string | null }>(COLLECTIONS.tasks)
      .findOne({ jobId } as never);
    assert.equal(task?.capability, 'chefAgent', 'the route must be part of the durable plan');
    assert.equal(task?.goal, 'design the menu', 'and so must the lane\'s refinement of the goal');
  });

  await check('the worker sees that specialist — a fresh process would too', async () => {
    const jobId = await newJob('plan a wedding menu');
    // A planning activation commits one proposal and ends; the attempt is
    // dispatched by the NEXT activation, so one lane call is never enough to
    // reach a worker.
    await runLaneForJob(client, db, jobId, 50, undefined, { decide: chefDecider } as never);
    await runLaneForJob(client, db, jobId, 50, undefined, { decide: chefDecider } as never);
    const seen: Array<string | null | undefined> = [];
    const seenGoals: string[] = [];
    const seenJobGoals: Array<string | undefined> = [];
    const seenTaskGoals: Array<string | null | undefined> = [];
    await drainWorkers(client, db, ((ctx: WorkerContext) => {
      seen.push(ctx.capability);
      seenGoals.push(ctx.goal);
      seenJobGoals.push(ctx.jobGoal);
      seenTaskGoals.push(ctx.taskGoal);
      return { status: 'ok', data: {} };
    }) as never);
    assert.deepEqual(seen, ['chefAgent'], 'the frozen capability must reach the router');
    assert.deepEqual(seenGoals, ['design the menu'], 'existing workers keep receiving the frozen task goal');
    assert.deepEqual(seenJobGoals, ['plan a wedding menu'], 'the immutable full job goal must also reach the agent');
    assert.deepEqual(seenTaskGoals, ['design the menu'], 'the lane refinement must remain a separate task focus');
  });

  await check('Writer progressive policy is frozen with the same durable plan', async () => {
    const registry = buildCapabilityRegistry({ allow: '*', defaultAgentId: 'researcherAgent' });
    const jobId = await newJob('write a five chapter story');
    const writerDecider = (async () => ({
      kind: 'dispatch',
      attemptMode: 'SERIAL',
      capability: 'writerAgent',
    })) as never;
    await runLaneForJob(client, db, jobId, 50, undefined, {
      decide: writerDecider,
      attemptCapFor: (name: string | null) => registry.attemptCapMsFor(name),
      progressiveAttemptFor: (name: string | null) => registry.progressiveAttemptPolicyFor(name),
    } as never);
    const task = await db.collection<TaskDoc>(COLLECTIONS.tasks).findOne({ jobId });
    assert.equal(task?.attemptCapMs, 2_700_000);
    assert.deepEqual(task?.progressiveAttempt, registry.progressiveAttemptPolicyFor('writerAgent'));
  });

  await check('the budget is frozen onto the task, not looked up at dispatch', async () => {
    // Frozen for the same reason the capability is: a retry after a restart must
    // run under the window the plan chose, not whatever config is loaded then.
    const jobId = await newJob('a long job');
    await runLaneForJob(client, db, jobId, 50, undefined, {
      decide: chefDecider,
      attemptCapFor: (name: string | null) => (name === 'chefAgent' ? 900_000 : 300_000),
    } as never);
    const task = await db.collection<{ attemptCapMs?: number | null }>(COLLECTIONS.tasks)
      .findOne({ jobId } as never);
    assert.equal(task?.attemptCapMs, 900_000);
  });

  await check('the frozen window is what the attempt actually runs under', async () => {
    const jobId = await newJob('another long job');
    for (let i = 0; i < 3; i++) {
      await runLaneForJob(client, db, jobId, 50, undefined, {
        decide: chefDecider,
        attemptCapFor: () => 900_000,
      } as never);
    }
    const attempt = await db.collection<{ businessOperationCutoffAt: Date; createdAt: Date }>(COLLECTIONS.attempts)
      .findOne({ jobId } as never);
    assert.ok(attempt, 'an attempt must exist');
    const windowMs = attempt.businessOperationCutoffAt.getTime() - attempt.createdAt.getTime();
    assert.ok(windowMs > 300_000, `the attempt must inherit the frozen budget, got ${windowMs}ms`);
  });

  await check('a plan with no capability keeps the pre-routing shape', async () => {
    const jobId = await newJob('anything');
    await runLaneForJob(client, db, jobId, 50, undefined);
    const task = await db.collection<{ capability?: string | null }>(COLLECTIONS.tasks)
      .findOne({ jobId } as never);
    assert.equal(task?.capability ?? null, null, 'the deterministic lane must not invent a route');
  });

  await db.dropDatabase().catch(() => undefined);
  await store.close();
}

if (failures > 0) {
  console.error(`\n❌ check:capability-routing — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:capability-routing — the lane names a specialist from a closed menu, and the plan remembers it');
process.exit(0);
