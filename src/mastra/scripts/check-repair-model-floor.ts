#!/usr/bin/env tsx
/**
 * check:repair-model-floor — the model that REPAIRS this system's code is a
 * strong one; small local workers do small targeted work.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * `smart-router.ts` sorts candidates by "prefer local if VRAM available
 * (cost = 0)", and its only quality filter is `estimatedComplexity` — a number
 * the diagnosing model produces about its own plan. Nothing distinguished
 * WRITING A REPAIR from summarising a log, so the autoheal cycle routed its code
 * edits to a 12B local model.
 *
 * Measured on both live G4 runs, 2026-08-17:
 *
 *   [SubtaskExecutor] Retry add-simulated-guard:
 *       Quality issues: no_files_changed, target_files_missed, empty_diagnostics
 *   [SubtaskExecutor] Escalate: ollama/local/gemma4:12b → bielik-11b
 *   → worktree pusty po implementacji (dwie próby) → cykl zatrzymany
 *
 * Note what the escalation ladder did: it answered a too-small model with
 * another local model, 12B → 11B. The saving was illusory anyway — a repair that
 * produces nothing costs a whole cycle and leaves the defect in place.
 *
 * The rule is NOT "no local models" globally — `research` subtasks still use
 * them; that is what workers are for. UPDATE (J7, 2026-08-23, owner decision):
 * terminal and qa moved off local too, but for a different reason than the
 * repair pin above — not a quality floor, a cost/availability choice. Local
 * command-running and verification work fine on a small model; the owner
 * chose to free that VRAM and route this cheap, fast work to cloud instead.
 * See `ROLES_EXCLUDED_FROM_LOCAL` in smart-router.ts.
 *
 * Run: npx tsx src/mastra/scripts/check-repair-model-floor.ts
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { routeSubtasks, subtaskWritesCode, type RoutableSubtask } from '../services/smart-router.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

console.log('check:repair-model-floor');

function subtask(id: string, type: string, extra: Partial<RoutableSubtask> = {}): RoutableSubtask {
  return { id, type, dependencies: [], targetFiles: ['src/mastra/index.ts'], ...extra };
}

const isLocal = (modelId?: string): boolean => String(modelId ?? '').startsWith('ollama/local/');

await check('a subtask that edits code is recognised, whatever it is called', () => {
  for (const type of ['edit', 'create', 'refactor', 'fix', 'patch']) {
    assert.equal(subtaskWritesCode({ type }), true, `${type} edits code`);
  }
  // Unknown types default to the strong model — the right direction to be wrong in.
  assert.equal(subtaskWritesCode({ type: 'something-nobody-declared' }), true,
    'an unrecognised type must land on the strong model, not on the cheapest one');
});

await check('and the small targeted work is still eligible for a local worker', () => {
  for (const type of ['test', 'build', 'install', 'run']) {
    assert.equal(subtaskWritesCode({ type }), false,
      `${type} is exactly what a local worker is for — pinning it to cloud would be a different mistake`);
  }
});

await check('PINNED: a repair subtask gets the coding domain\'s own model', async () => {
  // Owner's decision, 2026-08-17. Excluding local models left the router picking
  // the cheapest CLOUD model that claimed to handle the declared complexity —
  // and the complexity is declared by the diagnosing model about its own plan.
  // Measured after the exclusion alone: repairs ran on a 20B and only reached
  // gpt-5.3-mini by failing first.
  const { models } = await import('../config/model-manifest.js');
  const result = routeSubtasks([subtask('fix-the-bug', 'fix', { estimatedComplexity: 'simple' })]);
  const assignment = result.groups.flatMap((g) => g.subtasks)[0];
  assert.ok(assignment, 'the subtask must be routed');
  // Not conditional any more. The first version skipped itself when the key was
  // absent, which is exactly how `check:all` runs it — so the assertion that
  // matters most never ran and the gate still said green. `dotenv/config` at the
  // top of this file is what makes the key present; if it is genuinely missing
  // the gate should FAIL and say so, not quietly approve.
  assert.ok(process.env.DEEPSEEK_API_KEY,
    'DEEPSEEK_API_KEY must be loaded (dotenv/config) — without it this check cannot see the pin at all');
  assert.equal(assignment.model.modelId, models['deepseek-v4-pro'],
    'a repair must run on the coding domain\'s model, not on the cheapest thing that claims it can');
  assert.match(assignment.reason, /pinned/, 'and the decision must say why');
});

await check('FALLBACK: losing the pinned model must not reopen local models', async () => {
  // Behavioural. The first version asserted the ORDER of two lines in the source
  // and passed happily when the fallback was sabotaged to set skipLocal = false
  // — the pin was still succeeding, so the fallback branch never ran and the
  // shape assertion had nothing to notice. Take the pinned model away for real.
  const { getCircuitBreaker } = await import('../services/circuit-breaker.js');
  const { models } = await import('../config/model-manifest.js');
  const breaker = getCircuitBreaker();
  const pinnedId = models['deepseek-v4-pro'];

  // Trip it the way production trips it, rather than reaching into internals.
  for (let i = 0; i < 10; i += 1) breaker.recordFailure(pinnedId);
  try {
    assert.ok(breaker.isOpen(pinnedId), 'the pinned model must actually be unavailable now');
    const result = routeSubtasks([subtask('fix-it', 'fix', { estimatedComplexity: 'simple' })]);
    const assignment = result.groups.flatMap((g) => g.subtasks)[0];
    assert.ok(assignment, 'the subtask must still be routed — losing the pin is not a dead end');
    assert.notEqual(assignment.model.modelId, pinnedId, 'and not to the broken model');
    assert.equal(isLocal(assignment.model.modelId), false,
      'the fallback must stay in the cloud — a silent downgrade to a local model is the '
      + 'exact failure this whole check exists to prevent');
  } finally {
    breaker.reset(pinnedId);
  }
  assert.equal(breaker.isOpen(pinnedId), false, 'the gate must leave the breaker as it found it');
});

await check('ROUTING: a repair subtask never lands on a local model', () => {
  // The real router, with `preferLocal` at its default — the value the autoheal
  // workflow uses, because it passes nothing.
  const result = routeSubtasks([
    subtask('fix-the-bug', 'fix', { estimatedComplexity: 'simple' }),
    subtask('write-the-guard', 'edit', { estimatedComplexity: 'simple' }),
  ]);
  const assignments = result.groups.flatMap((g) => g.subtasks);
  assert.ok(assignments.length >= 2, 'both subtasks must be routed');
  for (const a of assignments) {
    assert.equal(isLocal(a.model.modelId), false,
      `${a.subtask.id} was assigned ${a.model.modelId} — a repair must not run on a small local model`);
  }
});

await check('ROUTING: terminal and qa subtasks no longer use a local worker (J7, 2026-08-23)', () => {
  // Owner's decision reversed this specific pair. Not a quality floor like the
  // repair pin above — a cost/availability choice: this work is cheap and fast
  // on a small CLOUD model, and moving it off local frees VRAM.
  for (const type of ['test', 'build', 'install', 'run', 'verify', 'lint', 'review', 'check', 'validate', 'e2e']) {
    const result = routeSubtasks([subtask(`run-${type}`, type, { estimatedComplexity: 'simple' })]);
    const assignment = result.groups.flatMap((g) => g.subtasks)[0];
    assert.ok(assignment, `${type} must be routed`);
    assert.equal(isLocal(assignment.model.modelId), false,
      `${type} (terminal/qa) was assigned ${assignment.model.modelId} — it must not land on a local model`);
  }
});

await check('ROUTING: a research subtask may still use a local worker — the exclusion is NOT global', () => {
  // If this ever fails on a machine with no GPU it is not a defect — the router
  // skips local candidates entirely then. The assertion is conditional on that.
  const result = routeSubtasks([subtask('look-it-up', 'research', { estimatedComplexity: 'simple' })]);
  const assignment = result.groups.flatMap((g) => g.subtasks)[0];
  assert.ok(assignment, 'the subtask must be routed');
  const gpuPresent = isLocal(assignment.model.modelId)
    || result.groups.some((g) => g.totalVramMb > 0);
  if (!gpuPresent) {
    console.log('    (no local candidate available here — the eligibility rule is still asserted above)');
    return;
  }
  assert.equal(isLocal(assignment.model.modelId), true,
    'a role the owner did NOT exclude must still be free to use a local worker — otherwise this is a ban, not a policy');
});

await check('FALLBACK #2: an infrastructure error must not hand a repair to a local model', async () => {
  // The router pins repairs to the coding model — and `findOfflineFallback` is a
  // SECOND, independent way to pick one. Its rule was "cloud error → cheapest
  // local with GPU available", so one 429 from the provider was enough to hand a
  // repair to a 4B model, silently, with a console.warn as the only trace.
  //
  // The general lesson, and the reason this check exists twice: when a decision
  // has two producers, pinning one is not pinning.
  const { findOfflineFallback } = await import('../services/subtask-executor.js');

  const cloudFailure = 'fetch failed: 429 rate limit';
  const forRepair = findOfflineFallback('custom-deepseek/deepseek/deepseek-v4-pro', cloudFailure,
    { type: 'fix' });
  if (forRepair) {
    assert.equal(isLocal(forRepair.modelId), false,
      `a repair fell back to ${forRepair.modelId} — local models are not eligible`);
  }

  // And terminal/qa (J7, 2026-08-23) get the SAME exclusion here as in the
  // primary router — findOfflineFallback is a second, independent producer of
  // this decision, and a role the owner moved off local must not silently
  // land back on it just because ITS cloud model also failed.
  const forTerminal = findOfflineFallback('custom-deepseek/deepseek/deepseek-v4-pro', cloudFailure,
    { type: 'test' });
  if (forTerminal) {
    assert.equal(isLocal(forTerminal.modelId), false,
      `terminal fell back to ${forTerminal.modelId} — terminal/qa are excluded from local, same as repairs`);
  }

  // A role the owner did NOT exclude (research) is untouched by either rule.
  const forResearch = findOfflineFallback('custom-deepseek/deepseek/deepseek-v4-pro', cloudFailure,
    { type: 'research' });
  if (forResearch && !isLocal(forResearch.modelId)) {
    console.log('    (no local candidate available here — the exclusion half above is what this asserts)');
  }

  // A LOGIC error is not an infrastructure error and must not re-route at all.
  assert.equal(
    findOfflineFallback('custom-deepseek/deepseek/deepseek-v4-pro', 'the model returned invalid JSON',
      { type: 'fix' }),
    null,
    'only infrastructure failures re-route; a logic error is for the retry path');
});

await check('the rule lives in the router, not in a caller that may forget it', () => {
  // A caller-side `preferLocal: false` would fix the autoheal path and leave
  // every other caller routing repairs to a 12B model.
  const src = readFileSync('src/mastra/services/smart-router.ts', 'utf-8');
  const selectAt = src.indexOf('function selectModel(');
  const body = src.slice(selectAt, src.indexOf('\nexport function routeSubtasks'));
  assert.match(body, /subtaskWritesCode\(/,
    'selectModel itself must apply the rule, so every caller inherits it');
  assert.match(body, /skipLocal = .*subtaskWritesCode|editsCode/,
    'and it must feed the same switch that a missing GPU feeds');
});

if (failures > 0) {
  console.error(`\n❌ check:repair-model-floor — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:repair-model-floor — repairs run on a strong model; workers do the small work');
process.exit(0);
