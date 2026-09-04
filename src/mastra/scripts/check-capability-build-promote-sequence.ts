#!/usr/bin/env tsx
/**
 * check:capability-build-promote-sequence — realPromote() must start the
 * candidate before it verifies it.
 *
 * WHY THIS IS A GATE AND NOT A CODE REVIEW NOTE
 * ----------------------------------------------
 * `realPromote()` in capability-build.ts (the CGP self-build promotion path)
 * ran this literal command list:
 *
 *   1. build-candidate.sh <commit> slot-b     (materializes + `mastra build`,
 *                                               starts NO process)
 *   2. verify-candidate.sh 4222                (polls :4222 for /health)
 *   3. promote-candidate.sh slot-b
 *   4. canary-watch.sh 4111 120
 *
 * build-candidate.sh only compiles the slot; nothing ever put a process on
 * :4222 before step 2 polled it. verify-candidate.sh's wait_health loop times
 * out (60s default) against an empty port every single time, so every real
 * invocation of this path would fail and roll back — regardless of whether
 * the build was good. This was never caught because check:capability-build-
 * gates/-lease inject a FAKE `promote` to test orchestration, never executing
 * the real command list (by design — see the module header). Found while
 * exercising F4 live: the tested orchestrator scripts/autoheal/run-deploy.sh
 * has a `start-candidate.sh` step between build and verify; this hand-rolled
 * duplicate of that sequence had fallen out of sync and dropped it.
 *
 * THE RULE: any command list in this codebase that re-implements the
 * build→start→verify→promote→canary sequence must keep start-candidate.sh
 * between build-candidate.sh and verify-candidate.sh, in that order.
 *
 * Run: npx tsx src/mastra/scripts/check-capability-build-promote-sequence.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

console.log('check:capability-build-promote-sequence');

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, '..', 'services', 'capability-build.ts'),
  'utf-8',
);

/** Extract the literal `steps = [...]` array body inside realPromote(). */
function extractPromoteSteps(src: string): string[] {
  const fnStart = src.indexOf('async function realPromote(');
  assert.ok(fnStart >= 0, 'realPromote() not found in capability-build.ts');
  const stepsStart = src.indexOf('const steps = [', fnStart);
  assert.ok(stepsStart >= 0, 'no `const steps = [...]` in realPromote()');
  const arrayStart = src.indexOf('[', stepsStart);
  const arrayEnd = src.indexOf(']', arrayStart);
  const body = src.slice(arrayStart + 1, arrayEnd);
  // Each entry is a quoted or template-literal string naming a script under
  // scripts/autoheal/. Pull the script basenames in order of appearance.
  return [...body.matchAll(/scripts\/autoheal\/([a-z-]+\.sh)/g)].map((m) => m[1]);
}

// ── The bug, reproduced against the OLD list, to prove the check is real ──
// This is not a copy for nostalgia: if this assertion did NOT fail against
// the pre-fix sequence, the check below would be trivially true and prove
// nothing.
check('the old 4-step sequence is correctly rejected', () => {
  const oldSteps = [
    'build-candidate.sh',
    'verify-candidate.sh',
    'promote-candidate.sh',
    'canary-watch.sh',
  ];
  assert.throws(
    () => assertStartBeforeVerify(oldSteps),
    /start-candidate\.sh must run before verify-candidate\.sh/,
    'the pre-fix 4-step list must fail this assertion — if it does not, the check below is not falsifiable',
  );
});

function assertStartBeforeVerify(steps: string[]): void {
  const startIdx = steps.indexOf('start-candidate.sh');
  const verifyIdx = steps.indexOf('verify-candidate.sh');
  assert.ok(verifyIdx >= 0, 'verify-candidate.sh missing from the sequence entirely');
  assert.ok(
    startIdx >= 0 && startIdx < verifyIdx,
    'start-candidate.sh must run before verify-candidate.sh, or verify-candidate ' +
      'polls a port nothing is listening on and the promotion always rolls back',
  );
}

check('realPromote() actually starts the candidate before verifying it', () => {
  const steps = extractPromoteSteps(source);
  assert.ok(steps.length > 0, 'could not parse any autoheal script names out of realPromote()');
  assertStartBeforeVerify(steps);
});

check('realPromote() keeps the full build→start→verify→promote→canary order', () => {
  const steps = extractPromoteSteps(source);
  assert.deepEqual(
    steps,
    ['build-candidate.sh', 'start-candidate.sh', 'verify-candidate.sh', 'promote-candidate.sh', 'canary-watch.sh'],
    `unexpected sequence: ${JSON.stringify(steps)}`,
  );
});

if (failures > 0) {
  console.error(`\n❌ check:capability-build-promote-sequence — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:capability-build-promote-sequence — the candidate is started before it is verified');
process.exit(0);
