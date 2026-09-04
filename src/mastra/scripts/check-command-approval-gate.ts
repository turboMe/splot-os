#!/usr/bin/env tsx
/**
 * check:command-approval-gate — the approval gate for workspace shell commands.
 *
 * This gate decides whether the coding agent may run a command itself or must
 * suspend and wait for a human. Both directions are load-bearing:
 *
 *   too strict → the agent suspends on a harmless `cat` and the autoheal repair
 *                loop stalls forever (observed live, 2026-07-22);
 *   too loose  → an agent runs `rm -rf` or reaches the network unattended.
 *
 * The live failure was NOT in the classifier — it was in reading the command out
 * of the payload. `args.command` was undefined, `String(undefined ?? '')` gave
 * '', and an empty command is neither read-only nor known-safe, so the gate
 * returned "approval required" for everything. Nothing logged it, because that
 * return value is indistinguishable from a real refusal.
 *
 * So this pins down BOTH halves: payload extraction and classification.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  requiresCodeCommandApproval,
  extractApprovalCommand,
} from '../workspaces/code-workspace.js';

let failures = 0;

async function ok_async(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

function ok(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

console.log('check:command-approval-gate');

// ── Payload extraction — the half that actually broke ────────────────────────
ok('extracts a flat { command } payload', () => {
  assert.equal(extractApprovalCommand({ command: 'cat file.ts' }), 'cat file.ts');
});

ok('extracts a { context: { command } } payload', () => {
  assert.equal(extractApprovalCommand({ context: { command: 'ls -la' } }), 'ls -la');
});

ok('unknown payload yields empty string (and therefore stays fail-safe)', () => {
  assert.equal(extractApprovalCommand({ nope: 1 }), '');
  assert.equal(extractApprovalCommand(undefined), '');
  assert.equal(extractApprovalCommand(null), '');
  // Fail-safe: an unreadable payload must still demand approval, never bypass.
  assert.equal(requiresCodeCommandApproval(extractApprovalCommand({ nope: 1 })), true);
});

// ── Regression: the exact live failure ───────────────────────────────────────
ok('REGRESSION: a plain `cat` through the real payload does NOT need approval', () => {
  const needsApproval = requiresCodeCommandApproval(
    extractApprovalCommand({ command: 'cat /projekty/x/src/lib/probe.ts' }),
  );
  assert.equal(needsApproval, false, 'cat must not suspend the agent — this stalled autoheal');
});

// ── Classification — must keep refusing what matters ─────────────────────────
for (const cmd of ['rm -rf /tmp/x', 'sudo reboot', 'git reset --hard', 'git push --force origin master']) {
  ok(`blocks destructive: ${cmd}`, () => {
    assert.equal(requiresCodeCommandApproval(cmd), true);
  });
}

for (const cmd of ['npm install lodash', 'curl https://example.com', 'git pull']) {
  ok(`gates network access: ${cmd}`, () => {
    assert.equal(requiresCodeCommandApproval(cmd), true);
  });
}

for (const cmd of ['ls -la src', 'git status', 'git diff HEAD', 'head -20 file.ts', 'npx tsc --noEmit', 'npm test']) {
  ok(`allows unattended: ${cmd}`, () => {
    assert.equal(requiresCodeCommandApproval(cmd), false);
  });
}

ok('unknown command still requires approval (default deny)', () => {
  assert.equal(requiresCodeCommandApproval('some-unknown-binary --flag'), true);
});

// ── ONE classification, four consumers ───────────────────────────────────────
// There were four copies of this rule and they had drifted. `npm run build`,
// `npx vitest` and `node --check` were allowed by the harness policy and
// SUSPENDED by the workspace gate; `npm run check:all` was permitted by one of
// the two allowlists inside `coding_run_test` and missing from the other, 40
// lines away in the same file. An agent told by its prompt to verify a change
// before merging got a different answer depending on which channel it asked.
const { classifyCommand, isUnattendedSafeCommand } = await import('../workspaces/command-safety.js');
const { evaluateAndLogHarnessPolicy } = await import('../services/harness-policy.js');

ok('the workspace gate IS the shared classification, not a second opinion', () => {
  for (const cmd of [
    'npm run build', 'npx vitest run', 'node --check src/x.ts', 'npm run check:all',
    'git commit -m x', 'npm install lodash', 'curl https://example.com', 'rm -rf /',
    'cat package.json', 'some-unknown-binary --flag',
  ]) {
    assert.equal(
      requiresCodeCommandApproval(cmd), !isUnattendedSafeCommand(cmd),
      `${cmd}: the suspending gate and the shared classifier must agree exactly`,
    );
  }
});

await (async () => {
  await ok_async('the harness policy reaches the same verdict as the workspace gate', async () => {
    for (const cmd of [
      'npm run build', 'npx vitest run', 'node --check src/x.ts', 'npm run check:all',
      'cat package.json', 'git status',
    ]) {
      const decision = await evaluateAndLogHarnessPolicy({ action: 'run_command', command: cmd } as never);
      assert.equal(decision.allow, isUnattendedSafeCommand(cmd),
        `${cmd}: policy and workspace must not disagree — that was the defect`);
    }
    for (const cmd of ['git commit -m x', 'npm install lodash', 'curl https://x', 'rm -rf /']) {
      const decision = await evaluateAndLogHarnessPolicy({ action: 'run_command', command: cmd } as never);
      assert.equal(decision.allow, false, `${cmd} must still need a human`);
    }
  });
})();

ok('the commands that used to disagree are now allowed everywhere', () => {
  // Chosen because each one is a real verification step the coding prompts ask
  // for, and each was refused on at least one channel.
  for (const cmd of ['npm run build', 'npx vitest run tests/x', 'node --check src/x.ts', 'npm run check:all']) {
    assert.equal(isUnattendedSafeCommand(cmd), true, `${cmd} is verification, not mutation`);
  }
});

ok('ORDER: a destructive git command is never read as read-only git', () => {
  // `git reset` and `git clean` start with `git ` and the read-only list has
  // `git branch`/`git status` in it, so classification order is load-bearing.
  assert.equal(classifyCommand('git reset --hard'), 'destructive');
  assert.equal(classifyCommand('git clean -fd'), 'destructive');
  assert.equal(classifyCommand('git branch -D feature'), 'git_mutation');
  assert.equal(classifyCommand('git branch'), 'read_only');
  assert.equal(classifyCommand('git worktree remove x'), 'git_mutation');
  assert.equal(classifyCommand('git worktree list'), 'read_only');
});

ok('ANTI-DRIFT: no coding tool may keep a private allowlist again', () => {
  for (const file of [
    'src/mastra/tools/dev/code-task-artifacts.ts',
    'src/mastra/workspaces/code-workspace.ts',
    'src/mastra/services/harness-policy.ts',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.ok(!source.includes('ALLOWED_PREFIXES'),
      `${file} defines its own allowlist — that is how four copies happened`);
  }
});

if (failures > 0) {
  console.error(`\n❌ check:command-approval-gate — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:command-approval-gate — all assertions passed');
process.exit(0);
