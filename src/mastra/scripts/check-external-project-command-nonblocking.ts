#!/usr/bin/env tsx
/**
 * K15 — `runExternalProjectCommandTool` used `execSync`, which blocks the
 * entire Node event loop for as long as the child process runs (up to its
 * 30s timeout) — every other concurrently running agent on the same server
 * would freeze. Fixed by switching to `spawn` (async, real `SIGKILL` on
 * timeout), mirroring the pattern already used by `meta-execute-command.ts`.
 *
 * This proves two things directly against the real `runCommand` helper
 * (not a re-implementation):
 * 1. the event loop keeps ticking while a child process is running (a
 *    setInterval fires many times during a ~300ms sleep — under the old
 *    execSync this would fire zero times, since the whole thread is blocked);
 * 2. a command that outlives its timeout is actually killed (SIGKILL), not
 *    left running or hanging the caller.
 *
 * Run: npx tsx src/mastra/scripts/check-external-project-command-nonblocking.ts
 */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { runCommand } from '../tools/dev/external-projects-tools.js';

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

console.log('check:external-project-command-nonblocking');

const cwd = mkdtempSync(join(tmpdir(), 'k15-nonblocking-'));

await check('event loop keeps ticking while the child command sleeps (not blocked like execSync)', async () => {
  let ticks = 0;
  const interval = setInterval(() => { ticks++; }, 10);
  try {
    const result = await runCommand('sleep 0.3', cwd, 5_000);
    assert.equal(result.timedOut, false, 'sleep 0.3 must not hit the timeout');
    assert.equal(result.exitCode, 0, 'sleep must exit cleanly');
  } finally {
    clearInterval(interval);
  }
  assert.ok(
    ticks >= 10,
    `expected the event loop to keep ticking during the 300ms child process (execSync would have blocked it entirely) — got ${ticks} ticks`,
  );
});

await check('a command that outlives its timeout is actually SIGKILLed, not left hanging', async () => {
  const startedAt = Date.now();
  const result = await runCommand('sleep 5 && echo should-not-print', cwd, 200);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.timedOut, true, 'expected timedOut=true');
  assert.ok(
    elapsedMs < 2_000,
    `expected the kill to land well before the child's own 5s sleep finishes, took ${elapsedMs}ms`,
  );
  assert.ok(
    !result.stdout.includes('should-not-print'),
    'the child must be killed before it can print — otherwise the timeout is cosmetic',
  );
});

await check('a normal command still returns real stdout and a real exit code', async () => {
  const result = await runCommand('echo hello-k15', cwd, 5_000);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('hello-k15'));
});

if (failures > 0) {
  console.error(`\n❌ check:external-project-command-nonblocking — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:external-project-command-nonblocking — K15 execSync fix verified: non-blocking, real kill on timeout');
process.exit(0);
