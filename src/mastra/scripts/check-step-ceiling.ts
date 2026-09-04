#!/usr/bin/env tsx
/**
 * The harness must not lower a step ceiling below what the agent declares.
 *
 * This is the defect that made `chefAgent` unusable on V2 while working fine on
 * legacy, and it is worth stating precisely because the two paths disagreed
 * silently:
 *
 *   legacy delegation  → `agent.generate(prompt, { memory })`  — no maxSteps,
 *                        so Mastra uses the agent's own `defaultOptions` (150)
 *   V2 / harness       → depth profile `deep` → maxSteps 40, overriding it
 *
 * `chefAgent` declares 150 because recon → profile → menu → recipes → book does
 * not fit in fewer. Given 40 it ran the entire 894s window and returned NO text,
 * the attempt failed empty, and the job ended FAILED — three separate
 * investigations (memory scoping, deliverable selection, attempt budget) went
 * past this because every one of them looked like a plausible cause.
 *
 * The rule: a ceiling may be RAISED by what the agent needs, never lowered below
 * it. Raising cannot make a short turn longer — the model stops when it is done
 * — while lowering below a pipeline's structural need converts a finished run
 * into a total loss plus a retry.
 *
 * Run: npx tsx src/mastra/scripts/check-step-ceiling.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

console.log('check:step-ceiling');

const DEPTH_SOURCE = readFileSync('src/mastra/services/depth-controller.ts', 'utf8');
const HARNESS_SOURCE = readFileSync('src/mastra/services/generate-with-harness.ts', 'utf8');

await check('the harness reads the agent\'s own declared ceiling', () => {
  assert.match(HARNESS_SOURCE, /getDefaultOptions/, 'it must ask the agent what it needs');
  assert.match(HARNESS_SOURCE, /stepCeilingFor/, 'and route the profile through the comparison');
});

await check('LIVE REGRESSION: a declared ceiling above the profile wins', async () => {
  const { chefAgent } = await import('../agents/chef-agent.js');
  const declared = await (chefAgent as unknown as {
    getDefaultOptions: (ctx: unknown) => Promise<{ maxSteps?: number }>;
  }).getDefaultOptions({});
  assert.equal(declared?.maxSteps, 150, 'chefAgent must still declare the steps its pipeline needs');

  const deepProfileMaxSteps = Number(
    DEPTH_SOURCE.match(/deep:\s*\{[^}]*?maxSteps:\s*(\d+)/s)?.[1],
  );
  assert.ok(Number.isFinite(deepProfileMaxSteps), 'the deep profile must be readable');
  assert.ok(
    declared.maxSteps! > deepProfileMaxSteps,
    `this is the exact collision: agent ${declared.maxSteps} vs profile ${deepProfileMaxSteps}`,
  );
});

await check('every agent that declares more than the deepest profile is covered', async () => {
  // Not just chef: writerAgent declares 150 too, and any future long pipeline
  // would hit the same wall. This asserts the RULE, not one agent.
  const { chefAgent } = await import('../agents/chef-agent.js');
  const { writerAgent } = await import('../agents/writer-agent.js');
  for (const [name, agent] of [['chefAgent', chefAgent], ['writerAgent', writerAgent]] as Array<[string, unknown]>) {
    const options = await (agent as { getDefaultOptions: (c: unknown) => Promise<{ maxSteps?: number }> })
      .getDefaultOptions({});
    assert.ok(
      typeof options?.maxSteps === 'number' && options.maxSteps > 0,
      `${name} must declare a usable ceiling for the harness to honour`,
    );
  }
});

await check('an agent that declares nothing leaves the profile in charge', async () => {
  // The fallback has to be silent and total: a framework that stops exposing
  // defaults must degrade to today's behaviour, not to zero steps.
  assert.match(
    HARNESS_SOURCE,
    /if \(declared === undefined \|\| declared <= profileMaxSteps\) return profileMaxSteps;/,
    'no declaration (or a smaller one) must keep the profile value exactly',
  );
});

await check('the raise is logged — a silently different ceiling is how this hid', () => {
  assert.match(HARNESS_SOURCE, /step ceiling raised to the agent's own/);
});

await check('the stopWhen backstop inherits the same ceiling', () => {
  // `stopWhen` replaces maxSteps in Mastra 1.32, so a ceiling raised in one place
  // and not the other would put the old 40 back through the side door.
  assert.match(
    HARNESS_SOURCE,
    /const stepCeiling = typeof generateOptions\.maxSteps === 'number'/,
    'the backstop must derive from the same generateOptions value',
  );
});

await check('the agent is TOLD the ceiling it actually has', () => {
  // The raise was real and the header did not know about it. Two of the three
  // budget lines printed effective values while `Max steps` printed the profile,
  // so a `fast` chefAgent run read "Max steps: 10" and ran with 150. The agent
  // has no other statement of its budget, so it rationed itself to the number in
  // front of it: 4 recipe cards for 18 dishes, five empty sections, finished in a
  // third of its window with nothing stopping it.
  assert.match(
    HARNESS_SOURCE,
    /`Max steps: \$\{runtime\.effectiveMaxSteps\}`/,
    'the depth header must print the RAISED ceiling, not the profile value it overrode',
  );
  assert.ok(
    !/`Max steps: \$\{depthProfile\.maxSteps\}`/.test(HARNESS_SOURCE),
    'and must not print the profile value anywhere — that is the number that was wrong',
  );
  assert.match(
    HARNESS_SOURCE,
    /effectiveMaxSteps: await stepCeilingFor\(input, depthProfile\.maxSteps\)/,
    'and it must come from the same resolver the run itself uses, not a second copy',
  );
});

if (failures > 0) {
  console.error(`\n❌ check:step-ceiling — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:step-ceiling — the harness may raise an agent\'s step ceiling, never lower it');
process.exit(0);
