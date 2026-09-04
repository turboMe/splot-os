#!/usr/bin/env tsx
/**
 * check:subtask-quality-loop — a subtask that did not do its job is caught,
 * retried, escalated, and eventually handed to a human. It never passes quietly.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * -----------------------------------
 * This is the only thing standing between "the model said it fixed it" and a
 * merge. Measured on the live autoheal cycles (2026-08-17), it is also the loop
 * that CAUGHT the too-small-model defect before any bad code reached review:
 *
 *   [SubtaskExecutor] Retry add-simulated-guard:
 *       Quality issues: no_files_changed, target_files_missed, empty_diagnostics
 *   [SubtaskExecutor] Escalate: gemma4:12b → bielik-11b
 *
 * Three of the five signals fired on real work. This gate covers all five plus
 * the two properties the live runs could not show: that escalation TERMINATES,
 * and that a file edited by two subtasks is reported rather than silently
 * last-write-wins.
 *
 * Run: npx tsx src/mastra/scripts/check-subtask-quality-loop.ts
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { validateSubtaskQuality } from '../services/subtask-executor.js';
import type { RoutableSubtask } from '../services/smart-router.js';

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

console.log('check:subtask-quality-loop');

function subtask(over: Partial<RoutableSubtask> = {}): RoutableSubtask {
  return { id: 's1', type: 'fix', dependencies: [], targetFiles: ['src/a.ts'], ...over };
}
function result(over: Record<string, unknown> = {}) {
  return {
    subtaskId: 's1',
    status: 'success' as const,
    assignedModel: 'm',
    filesChanged: [{ path: 'src/a.ts', summary: 'fixed' }],
    commandsRun: [],
    diagnostics: 'Found the null deref on line 42 and added a guard.',
    errors: [],
    durationMs: 10,
    ...over,
  } as never;
}

// ── J3: the five signals ─────────────────────────────────────────────────────
await check('J3: a subtask that changed nothing is caught', async () => {
  const v = await validateSubtaskQuality(subtask(), result({ filesChanged: [] }));
  assert.ok(v.signals.includes('no_files_changed'), 'an empty edit must not pass');
  assert.equal(v.passed, false);
});

await check('J3: a TEST subtask changing nothing is NOT a defect', async () => {
  // Running tests changes no files. Flagging that would make the loop fight the
  // one subtask type whose success looks like inaction.
  const v = await validateSubtaskQuality(subtask({ type: 'test' }), result({ filesChanged: [] }));
  assert.ok(!v.signals.includes('no_files_changed'), 'a test that edits nothing is doing its job');
});

await check('J3: editing the wrong files is caught', async () => {
  const v = await validateSubtaskQuality(
    subtask({ targetFiles: ['src/wanted.ts'] }),
    result({ filesChanged: [{ path: 'src/something-else.ts', summary: 'x' }] }),
  );
  assert.ok(v.signals.includes('target_files_missed'), 'the named target must actually be touched');
});

await check('J3: a failing typecheck is caught', async () => {
  const v = await validateSubtaskQuality(subtask(), result({
    commandsRun: [{ command: 'npx tsc --noEmit', exitCode: 2, output: 'error TS2345' }],
  }));
  assert.ok(v.signals.includes('tsc_errors'), 'a red typecheck must not pass as success');
});

await check('J3: a later passing typecheck clears an earlier failure', async () => {
  const v = await validateSubtaskQuality(subtask(), result({
    commandsRun: [
      { command: 'npx tsc --noEmit', exitCode: 2, output: 'error TS2345' },
      { command: 'npx tsc --noEmit', exitCode: 0, output: '' },
    ],
  }));
  assert.ok(!v.signals.includes('tsc_errors'), 'the latest typecheck is green and must supersede the earlier red run');
  assert.equal(v.passed, true);
});

await check('J3: the agent saying it failed is believed — in either language', async () => {
  for (const said of [
    'Failed to locate the module.',
    'Nie udało się znaleźć pliku.',
    'Nie mogę tego naprawić bez dostępu do bazy.',
  ]) {
    const v = await validateSubtaskQuality(subtask(), result({ diagnostics: said }));
    assert.ok(v.signals.includes('agent_reported_failure'),
      `"${said}" is the agent reporting failure and must be treated as one`);
  }
});

await check('J3: an empty account of the work is caught', async () => {
  const v = await validateSubtaskQuality(subtask(), result({ diagnostics: '   ' }));
  assert.ok(v.signals.includes('empty_diagnostics'),
    'a change nobody described cannot be reviewed');
});

await check('J3: honest good work passes — the loop is not a blockade', async () => {
  const v = await validateSubtaskQuality(subtask(), result());
  assert.deepEqual(v.signals, [], `clean work must produce no signals, got ${v.signals.join(', ')}`);
  assert.equal(v.passed, true);
});

await check('J3: every declared signal has a producer', async () => {
  // `partial_completion` was declared in the union and emitted by nothing, in
  // legacy and since — which is how the migration inventory came to promise six
  // quality checks when there have only ever been five.
  const src = readFileSync('src/mastra/services/subtask-executor.ts', 'utf-8');
  const union = src.slice(src.indexOf('type QualitySignal'), src.indexOf('export interface QualityValidation'));
  const declared = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  assert.ok(declared.length > 0, 'the signal vocabulary must be readable');
  for (const signal of declared) {
    assert.ok(src.includes(`signals.push('${signal}')`),
      `${signal} is declared but nothing emits it — a check that exists only in a type`);
  }
});

// ── J4: escalation terminates ────────────────────────────────────────────────
await check('J4: the escalation ladder only ever goes UP, and ends', () => {
  const src = readFileSync('src/mastra/services/subtask-executor.ts', 'utf-8');
  const block = src.slice(src.indexOf('const ESCALATION_PATH'), src.indexOf('const MAX_RETRY_ATTEMPTS'));
  const tiers = ['local-micro', 'local-light', 'local-heavy', 'cloud-free', 'cloud-fast', 'cloud-pro'];
  const rank = new Map(tiers.map((t, i) => [t, i]));
  const rows = [...block.matchAll(/'([a-z-]+)':\s*\[([^\]]*)\]/g)];
  assert.equal(rows.length, tiers.length, 'every tier must declare where it escalates to');
  for (const [, from, toList] of rows) {
    const targets = [...toList!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
    for (const to of targets) {
      assert.ok(rank.get(to)! > rank.get(from!)!,
        `${from} → ${to} is not an escalation — a ladder that steps sideways or down loops`);
    }
  }
  // The top must be a dead end, or three attempts never become "needs a human".
  const top = rows.find(([, from]) => from === 'cloud-pro');
  assert.ok(top && !/'/.test(top[2]!), 'the strongest tier must have nowhere to escalate to');
});

await check('J4: running out of ladder means needs_human, not silent success', () => {
  const src = readFileSync('src/mastra/services/subtask-executor.ts', 'utf-8');
  assert.match(src, /No escalation model available[\s\S]{0,120}needs_human/,
    'with nothing stronger left, the subtask must be handed to a person');
  assert.match(src, /escalatedQuality\.passed \? 'success' : 'needs_human'/,
    'and an escalation that still fails quality must not be reported as success');
});

// ── J6: two subtasks editing one file ────────────────────────────────────────
await check('J6: a file edited by two subtasks is reported as a conflict', () => {
  const src = readFileSync('src/mastra/services/parallel-dispatch.ts', 'utf-8');
  const at = src.indexOf('Detect conflicts');
  assert.ok(at > 0, 'conflict detection must exist');
  const block = src.slice(at, at + 600);
  assert.match(block, /length > 1/, 'a file with more than one editor is the definition');
  // And it must reach a human-readable summary, not just a field nobody prints.
  assert.match(src, /Conflicting files:/,
    'a detected conflict that is never shown is not detection');
});

if (failures > 0) {
  console.error(`\n❌ check:subtask-quality-loop — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:subtask-quality-loop — bad work is caught, escalated, and ends with a human');
process.exit(0);
