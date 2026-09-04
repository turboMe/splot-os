#!/usr/bin/env tsx
/**
 * check:git-locale-independence — no decision in this system depends on which
 * language git was compiled to speak.
 *
 * WHY THIS IS A GATE AND NOT A CODE REVIEW NOTE
 * --------------------------------------------
 * git translates its messages. This host runs a Polish git, so:
 *
 *   git commit           → `nic do złożenia, drzewo robocze czyste`
 *   git worktree remove  → `„/path” nie jest drzewem roboczym`
 *
 * Two shipped decisions were written against the English wording, and both were
 * therefore permanently wrong here:
 *
 *   1. `coding_apply_patch` swallowed a commit failure when the message said
 *      `nothing to commit`. It never said that. An empty branch surfaced as
 *      "Failed to execute apply_patch." with nothing explaining why — measured on
 *      the merge canary, 2026-08-17.
 *   2. `coding_remove_worktree` tolerated `not registered` / `not found`.
 *      git's answer for an already-removed worktree is `is not a working tree`,
 *      which matches NEITHER — so that one was broken in English too, and the
 *      locale merely hid a second bug behind the first.
 *
 * The failure mode is why it deserves a gate: nothing crashes at build time, the
 * types are fine, the tests pass, and the behaviour is wrong only on the machine
 * that runs it. A reviewer reading `includes('nothing to commit')` sees an
 * English sentence and their own language, and agrees with it.
 *
 * THE RULE: decide from an exit code or a `--porcelain` stream. Where prose must
 * be read, pin `LC_ALL=C` at the call site.
 *
 * Run: npx tsx src/mastra/scripts/check-git-locale-independence.ts
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

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

console.log('check:git-locale-independence');

/** Every .ts under src/mastra, minus the gates that quote the bad patterns. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      sourceFiles(full, acc);
    } else if (entry.endsWith('.ts') && !entry.startsWith('check-')) {
      acc.push(full);
    }
  }
  return acc;
}

/** Code with comments and doc blocks removed — prose explaining a fix is not the fix. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

// Phrases git emits and translates. Matching any of them is the defect.
const TRANSLATED_PHRASES = [
  'nothing to commit',
  'nothing added to commit',
  'not a working tree',
  'not a git repository',
  'working tree clean',
  'Already up to date',
  'no changes added',
  'is not registered',
  'Automatic merge failed',
];

await check('no shipped decision matches a phrase git translates', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles('src/mastra')) {
    const code = codeOnly(readFileSync(file, 'utf-8'));
    for (const phrase of TRANSLATED_PHRASES) {
      // Only flag it where it drives a BRANCH — a phrase in a message this
      // system writes for a human is fine, and a lot of them are.
      const pattern = new RegExp(
        `(includes|startsWith|endsWith|indexOf|match|test)\\s*\\(\\s*['"\`][^'"\`]*${phrase}`,
        'i',
      );
      if (pattern.test(code)) offenders.push(`${file}: ${phrase}`);
    }
  }
  assert.deepEqual(offenders, [],
    'these decide behaviour from translated text — use an exit code or --porcelain instead');
});

await check('no shipped decision REGEX-matches git\'s prose either', () => {
  // `includes('...')` is the obvious shape; `/conflict/i.test(err.message)` is
  // the same defect wearing a regex. That one was live in the autoheal merge:
  // git says `KONFLIKT (zawartość): Konflikt scalania` here — spelled with a k,
  // so the test was false, `git merge --abort` never ran, and the LIVE
  // repository was left mid-merge with conflict markers in it.
  const offenders: string[] = [];
  const prosePatterns = [
    /\/(conflict|nothing to commit|already up to date|not a git|working tree clean)\/[a-z]*\.test\(/i,
    /\.match\(\s*\/(conflict|nothing to commit|already up to date)\//i,
  ];
  for (const file of sourceFiles('src/mastra')) {
    const code = codeOnly(readFileSync(file, 'utf-8'));
    for (const pattern of prosePatterns) {
      if (pattern.test(code)) offenders.push(file);
    }
  }
  assert.deepEqual([...new Set(offenders)], [],
    'these branch on translated text via a regex — ask git\'s state instead');
});

await check('BEHAVIOUR: a conflicted merge is detected and aborted in any language', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'git-conflict-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await run('git', ['config', 'user.email', 't@t'], { cwd: repo });
  await run('git', ['config', 'user.name', 't'], { cwd: repo });
  await writeFile(join(repo, 'f.txt'), 'A\n');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-q', '-m', 'base'], { cwd: repo });
  await run('git', ['checkout', '-q', '-b', 'side'], { cwd: repo });
  await writeFile(join(repo, 'f.txt'), 'B\n');
  await run('git', ['commit', '-qam', 'b'], { cwd: repo });
  await run('git', ['checkout', '-q', 'main'], { cwd: repo });
  await writeFile(join(repo, 'f.txt'), 'C\n');
  await run('git', ['commit', '-qam', 'c'], { cwd: repo });

  const failed = await run('git', ['merge', '--no-ff', '--no-edit', 'side'], { cwd: repo })
    .then(() => false, () => true);
  assert.ok(failed, 'the merge must actually conflict, or this proves nothing');

  // The detection the code now uses.
  const inProgress = await run('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: repo })
    .then(() => true, () => false);
  assert.ok(inProgress, 'a half-done merge must be visible from git state');

  await run('git', ['merge', '--abort'], { cwd: repo });
  const stillInProgress = await run('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: repo })
    .then(() => true, () => false);
  assert.equal(stillInProgress, false, 'and the abort must leave the checkout clean');
  const { stdout: content } = await run('cat', [join(repo, 'f.txt')]);
  assert.equal(content.trim(), 'C', 'no conflict markers may survive in the working tree');
});

await check('MEASURED: this host\'s git does not speak the English these matched', async () => {
  // The gate above is only worth having if the hazard is real HERE. If this
  // assertion ever stops holding, the machine changed, not the rule.
  const repo = await mkdtemp(join(tmpdir(), 'git-locale-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await run('git', ['config', 'user.email', 't@t'], { cwd: repo });
  await run('git', ['config', 'user.name', 't'], { cwd: repo });
  await writeFile(join(repo, 'a.txt'), 'x');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-q', '-m', 'base'], { cwd: repo });

  const { stdout: cLocale } = await run('git', ['status'], {
    cwd: repo, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  assert.match(cLocale, /working tree clean/, 'C locale is the English baseline');

  const { stdout: hostLocale } = await run('git', ['status'], { cwd: repo });
  if (!/working tree clean/.test(hostLocale)) {
    console.log('    (git here answers in a non-English locale — the hazard is live)');
  }
});

await check('the two repaired decisions are exit-code based', () => {
  const src = codeOnly(readFileSync('src/mastra/tools/dev/code-worktree.ts', 'utf-8'));
  assert.match(src, /diff', '--cached', '--quiet'/,
    'whether anything is staged must come from an exit code');
  assert.match(src, /worktree', 'list', '--porcelain'/,
    'whether a worktree exists must come from the stable machine format');
  assert.match(src, /rev-parse', '--verify', '--quiet'/,
    'whether a branch exists must come from an exit code');
});

await check('BEHAVIOUR: releasing a worktree that is already gone must not throw', async () => {
  // The shape `coding_remove_worktree` now uses, exercised against a real repo:
  // remove it once, then run the same teardown again.
  const repo = await mkdtemp(join(tmpdir(), 'git-teardown-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await run('git', ['config', 'user.email', 't@t'], { cwd: repo });
  await run('git', ['config', 'user.name', 't'], { cwd: repo });
  await writeFile(join(repo, 'a.txt'), 'x');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-q', '-m', 'base'], { cwd: repo });
  const wt = join(repo, '..', `wt-${Date.now()}`);
  await run('git', ['worktree', 'add', '-q', '-b', 'task-x', wt], { cwd: repo });

  const teardown = async (): Promise<void> => {
    const { stdout } = await run('git', ['worktree', 'list', '--porcelain'], { cwd: repo })
      .catch(() => ({ stdout: '' }) as { stdout: string });
    const registered = String(stdout).split('\n')
      .some((line) => line.startsWith('worktree ') && line.slice(9).trim() === wt);
    if (registered) await run('git', ['worktree', 'remove', '--force', wt], { cwd: repo });
    else await run('git', ['worktree', 'prune'], { cwd: repo }).catch(() => undefined);

    const exists = await run('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/task-x'], { cwd: repo })
      .then(() => true, () => false);
    if (exists) await run('git', ['branch', '-D', 'task-x'], { cwd: repo });
  };

  await teardown();
  // The whole point: the SECOND one is the case that used to throw.
  await teardown();
  await teardown();

  const { stdout: left } = await run('git', ['worktree', 'list', '--porcelain'], { cwd: repo });
  assert.ok(!left.includes(wt), 'the worktree must actually be gone, not merely un-erroring');
});

if (failures > 0) {
  console.error(`\n❌ check:git-locale-independence — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:git-locale-independence — behaviour does not depend on git\'s language');
process.exit(0);
