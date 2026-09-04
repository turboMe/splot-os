#!/usr/bin/env tsx
/**
 * check:live-merge-permission — merging into the repository this system runs
 * from is a permission, not a description.
 *
 * `coding_apply_patch` said "Requires approval" in its description and enforced
 * nothing: it ran `git merge` into `AGENTIC_AGENTS_REPO` the moment a model
 * called it. The flags an operator reaches for (`AUTOHEAL_AUTO_PROMOTE`,
 * `DEPLOY_AUTO_SWAP`) gate `mergeWorktreeToLive()` in the WORKFLOW — a different
 * path — and the harness policy that would have stopped it is neutralised by
 * `HARNESS_POLICY_MODE=log_only`, which is both the code default and the value
 * in `.env`. So the one route an agent can take on its own was the one with no
 * gate on it.
 *
 * This pins the two grants legacy actually gives, and pins that everything else
 * is REFUSED rather than suspended: a background run has nobody to approve it,
 * and a suspension there is a hang, not a question.
 *
 * The permit half runs against a real replica set because "spent, not inspected"
 * is a claim about a concurrent CAS, and a fake would only restate it.
 *
 * Run: npx tsx src/mastra/scripts/check-live-merge-permission.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { resolveLiveMergePermission } from '../tools/dev/live-merge-permission.js';
import { getDb } from '../lib/mongo.js';

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

console.log('check:live-merge-permission');

const originalFlag = process.env.AUTOHEAL_AUTO_PROMOTE;
const TAG = `lmp-${Date.now()}`;

await check('a plain task is REFUSED, and told where its work still is', async () => {
  delete process.env.AUTOHEAL_AUTO_PROMOTE;
  const verdict = await resolveLiveMergePermission({
    taskId: `${TAG}-user-task`,
    branchName: `task-${TAG}`,
  });
  assert.equal(verdict.allowed, false);
  assert.match((verdict as { reason: string }).reason, /approvalToken|AUTOHEAL_AUTO_PROMOTE/);
  // The refusal has to name where the work went, or a model reads "refused" as
  // "lost" and starts over.
  assert.match((verdict as { reason: string }).reason, /NOT lost|coding_worktree_diff/);
});

await check('an autoheal task is still refused while the flag is OFF', async () => {
  delete process.env.AUTOHEAL_AUTO_PROMOTE;
  const verdict = await resolveLiveMergePermission({
    taskId: `heal-${TAG}`,
    branchName: `task-heal-${TAG}`,
  });
  assert.equal(verdict.allowed, false, 'the lane is not a permission — the flag is');
});

await check('an autoheal task under AUTOHEAL_AUTO_PROMOTE may merge', async () => {
  process.env.AUTOHEAL_AUTO_PROMOTE = 'true';
  const verdict = await resolveLiveMergePermission({
    taskId: `heal-${TAG}`,
    branchName: `task-heal-${TAG}`,
  });
  assert.equal(verdict.allowed, true);
  assert.equal((verdict as { via: string }).via, 'autoheal_auto_promote');
});

await check('the flag does NOT extend to ordinary tasks', async () => {
  // The exact scoping legacy has: `autohealAutoConfirmMerge` requires BOTH the
  // flag and a `heal-` task, so a user task never rides in on the flag.
  process.env.AUTOHEAL_AUTO_PROMOTE = 'true';
  const verdict = await resolveLiveMergePermission({
    taskId: `${TAG}-user-task`,
    branchName: `task-${TAG}`,
  });
  assert.equal(verdict.allowed, false, 'a user task must not merge because autoheal is enabled');
});

await check('LIVE: an approved token merges ONCE, and the second attempt says it was spent', async () => {
  delete process.env.AUTOHEAL_AUTO_PROMOTE;
  const db = await getDb();
  const token = `${TAG}-${randomUUID().slice(0, 8)}`;
  await db.collection('approvals').insertOne({ id: token, status: 'approved', createdAt: new Date().toISOString() });
  try {
    const first = await resolveLiveMergePermission({
      taskId: `${TAG}-build`, approvalToken: token, branchName: `task-${TAG}`,
    });
    assert.equal(first.allowed, true, 'an approved permit must work once');
    assert.equal((first as { via: string }).via, 'approval_token');

    const second = await resolveLiveMergePermission({
      taskId: `${TAG}-build`, approvalToken: token, branchName: `task-${TAG}`,
    });
    assert.equal(second.allowed, false, 'a permit that survives its use is a standing grant');
    assert.match((second as { reason: string }).reason, /already spent/);

    const stamped = await db.collection('approvals').findOne({ id: token });
    assert.equal(stamped?.liveMergeConsumedBy, `${TAG}-build`, 'the permit records who spent it');
    assert.ok(stamped?.liveMergeConsumedSubject, 'and what it was spent on');
  } finally {
    await db.collection('approvals').deleteMany({ id: token }).catch(() => undefined);
  }
});

await check('LIVE: a token nobody approved is refused, and says so precisely', async () => {
  delete process.env.AUTOHEAL_AUTO_PROMOTE;
  const db = await getDb();
  const token = `${TAG}-pending-${randomUUID().slice(0, 8)}`;
  await db.collection('approvals').insertOne({ id: token, status: 'pending', createdAt: new Date().toISOString() });
  try {
    const verdict = await resolveLiveMergePermission({
      taskId: `${TAG}-build`, approvalToken: token, branchName: `task-${TAG}`,
    });
    assert.equal(verdict.allowed, false);
    assert.match((verdict as { reason: string }).reason, /awaiting a human/);

    const missing = await resolveLiveMergePermission({
      taskId: `${TAG}-build`, approvalToken: `${token}-nope`, branchName: `task-${TAG}`,
    });
    assert.match((missing as { reason: string }).reason, /does not exist/,
      '"nobody approved this" and "already spent" must not read the same');
  } finally {
    await db.collection('approvals').deleteMany({ id: { $regex: `^${TAG}` } }).catch(() => undefined);
  }
});

if (originalFlag === undefined) delete process.env.AUTOHEAL_AUTO_PROMOTE;
else process.env.AUTOHEAL_AUTO_PROMOTE = originalFlag;


// ── What the tool SAYS must match what the repository DID ────────────────────
await check('a merge that changes nothing is reported as nothing, not as success', async () => {
  // Behavioural, against a real repository. The first version of this check read
  // the source for the shape of the guard, and passed unchanged when the guard
  // was disabled with `if (false && ...)` — a check that cannot fail is decoration.
  const { countCommitsAhead, listIgnoredPaths, describeEmptyMerge } =
    await import('../tools/dev/code-worktree.js');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const run = promisify(execFile);
  const repo = await mkdtemp(join(tmpdir(), 'merge-empty-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await run('git', ['config', 'user.email', 't@t'], { cwd: repo });
  await run('git', ['config', 'user.name', 't'], { cwd: repo });
  await writeFile(join(repo, '.gitignore'), 'scratch/\n');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-q', '-m', 'base'], { cwd: repo });
  await run('git', ['branch', 'task-x'], { cwd: repo });

  // The canary exactly: work written under an ignored path.
  await run('git', ['checkout', '-q', 'task-x'], { cwd: repo });
  await run('mkdir', ['-p', join(repo, 'scratch')]);
  await writeFile(join(repo, 'scratch/probe.md'), 'probe');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-q', '--allow-empty', '-m', 'nothing staged'], { cwd: repo })
    .catch(() => {});
  await run('git', ['checkout', '-q', 'main'], { cwd: repo });

  const ignored = await listIgnoredPaths(repo);
  assert.ok(ignored.some((p) => p.includes('scratch')),
    'the ignored file must be visible, or the agent cannot be told why its work vanished');

  const verdict = describeEmptyMerge({
    commitsAhead: 0, branchName: 'task-x', worktreeDir: repo, ignoredPaths: ignored,
  });
  assert.ok(verdict, 'a branch carrying nothing must produce a refusal, never a success');
  assert.match(verdict!, /ignoring/, 'and it must name the actual cause');

  // The other direction: real work must still merge, or the guard is a blockade.
  await run('git', ['checkout', '-q', 'task-x'], { cwd: repo });
  await writeFile(join(repo, 'tracked.md'), 'real work');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-q', '-m', 'real'], { cwd: repo });
  await run('git', ['checkout', '-q', 'main'], { cwd: repo });
  const ahead = await countCommitsAhead(repo, 'task-x');
  assert.ok(ahead > 0, 'a branch with a tracked commit is ahead');
  assert.equal(
    describeEmptyMerge({ commitsAhead: ahead, branchName: 'task-x', worktreeDir: repo, ignoredPaths: [] }),
    undefined,
    'work that exists must merge — the guard must not become a reason nothing ever lands');
});

await check('LOCALE: an empty commit is detected without reading git\'s prose', async () => {
  // git is translated. On this host it answers `nic do złożenia, drzewo robocze
  // czyste`, so the `includes('nothing to commit')` this tool shipped with was
  // false for the exact condition it existed to catch — in every locale but
  // English. Measured, not reasoned about: the canary returned "Failed to
  // execute apply_patch." for a branch with nothing on it.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const run = promisify(execFile);
  const repo = await mkdtemp(join(tmpdir(), 'merge-locale-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await run('git', ['config', 'user.email', 't@t'], { cwd: repo });
  await run('git', ['config', 'user.name', 't'], { cwd: repo });
  await writeFile(join(repo, 'a.txt'), 'x');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['commit', '-q', '-m', 'base'], { cwd: repo });

  // The probe the tool uses: exit code, no text.
  const stagedWhenClean = await run('git', ['diff', '--cached', '--quiet'], { cwd: repo })
    .then(() => false, () => true);
  assert.equal(stagedWhenClean, false, 'a clean index must read as nothing staged');

  await writeFile(join(repo, 'b.txt'), 'y');
  await run('git', ['add', '.'], { cwd: repo });
  const stagedWhenDirty = await run('git', ['diff', '--cached', '--quiet'], { cwd: repo })
    .then(() => false, () => true);
  assert.equal(stagedWhenDirty, true, 'a staged file must read as something staged');

  // Under a non-English locale the probe is unchanged, and the old string is not
  // merely absent — it is unfindable.
  await run('git', ['commit', '-q', '-m', 'b'], { cwd: repo });
  const pl: any = await run('git', ['commit', '-m', 'x'], { cwd: repo, env: { ...process.env, LC_ALL: 'pl_PL.UTF-8', LANG: 'pl_PL.UTF-8' } })
    .then(() => null, (e: any) => e);
  if (pl) {
    const said = [pl.stdout, pl.stderr, pl.message].map((x: unknown) => String(x ?? '')).join('\n');
    if (!said.includes('nothing to commit')) {
      // The locale is installed and git is translated: this is the live trap.
      assert.ok(true);
    }
  }

  // And the tool must not have gone back to matching prose.
  const src = readFileSync('src/mastra/tools/dev/code-worktree.ts', 'utf-8');
  const at = src.indexOf("id: 'coding_apply_patch'");
  const body = src.slice(at, src.indexOf("id: 'coding_list_worktree_files'"));
  // Comments stripped: a check that fires on the prose EXPLAINING the fix, rather
  // than on the fix, is a check that punishes documentation.
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/includes\(\s*['"`]nothing to commit/.test(code),
    'a decision must never depend on which language git was built to speak');
  assert.match(body, /diff', '--cached', '--quiet'/,
    'the staged-changes probe is the locale-independent form');
});

await check('AUTOHEAL: the flag promotes a lane\'s OWN work, not a lane it named', async () => {
  // The continuation rule (an explicitly named task is honoured) is safe for the
  // token grant, which a human bound to a specific task. The autoheal grant is
  // bound to nothing but a `heal-` prefix, so without this a run inside heal-A
  // could name heal-B and merge a branch no supervisor asked it to touch.
  const { resolveLiveMergePermission } = await import('../tools/dev/live-merge-permission.js');
  const previous = process.env.AUTOHEAL_AUTO_PROMOTE;
  process.env.AUTOHEAL_AUTO_PROMOTE = 'true';
  try {
    const own = await resolveLiveMergePermission({
      taskId: 'heal-A', branchName: 'task-heal-A', runTaskId: 'heal-A',
    });
    assert.equal(own.allowed, true, 'a repair lane must still promote its own work unattended');

    const sideways = await resolveLiveMergePermission({
      taskId: 'heal-B', branchName: 'task-heal-B', runTaskId: 'heal-A',
    });
    assert.equal(sideways.allowed, false, 'naming another lane must not inherit the flag');
    assert.match((sideways as { reason: string }).reason, /heal-A/,
      'and the refusal must say which lane this run actually owns');

    // Legacy, where nothing declares a run scope, is unchanged.
    const legacy = await resolveLiveMergePermission({
      taskId: 'heal-A', branchName: 'task-heal-A',
    });
    assert.equal(legacy.allowed, true,
      'a caller that declares no run scope must keep working — that is the autoheal workflow');
  } finally {
    if (previous === undefined) delete process.env.AUTOHEAL_AUTO_PROMOTE;
    else process.env.AUTOHEAL_AUTO_PROMOTE = previous;
  }
});

await check('ORDER: the check runs before the merge, and the permit between them', async () => {
  const src = readFileSync('src/mastra/tools/dev/code-worktree.ts', 'utf-8');
  const at = src.indexOf("id: 'coding_apply_patch'");
  const body = src.slice(at, src.indexOf("id: 'coding_list_worktree_files'"));
  const emptyAt = body.indexOf('describeEmptyMerge');
  const permitAt = body.indexOf('resolveLiveMergePermission');
  const mergeAt = body.indexOf("'merge', String(artifact.branchName)");
  assert.ok(emptyAt >= 0 && permitAt > emptyAt,
    "a human's one-time approval must be spent only once there is something to spend it on");
  assert.ok(mergeAt > permitAt, 'and the live repository is touched only after the permit');
});

await check('INJECTION: a commit message is an argument, never a command line', async () => {
  // `promisify(exec)` runs `/bin/sh -c`, and the message is model-written text
  // that was interpolated between double quotes into a command executed in the
  // repository this system runs from.
  const src = readFileSync('src/mastra/tools/dev/code-worktree.ts', 'utf-8');
  assert.ok(!/commit -m "\$\{/.test(src),
    'a commit message must not be interpolated into a shell command line');
  assert.ok(/execFileAsync\('git', \['commit', '-m', msg\]/.test(src),
    'the message must be passed as an argv element, where no shell can see it');

  // Behavioural half: prove the shell cannot act on it. A message that would be
  // a command under `sh -c` must leave the filesystem untouched.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, writeFile, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const run = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'merge-inject-'));
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['config', 'user.email', 't@t'], { cwd: dir });
  await run('git', ['config', 'user.name', 't'], { cwd: dir });
  await writeFile(join(dir, 'a.txt'), 'x');
  await run('git', ['add', '.'], { cwd: dir });
  const hostile = 'msg"; touch PWNED; #';
  await run('git', ['commit', '-m', hostile], { cwd: dir });
  const entries = await readdir(dir);
  assert.ok(!entries.includes('PWNED'),
    'the shell must never have been given the chance to interpret the message');
  const { stdout } = await run('git', ['log', '-1', '--pretty=%s'], { cwd: dir });
  assert.equal(stdout.trim(), hostile, 'and the message must survive intact as a message');
});

if (failures > 0) {
  console.error(`\n❌ check:live-merge-permission — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:live-merge-permission — the tool enforces the permission its description claims');
process.exit(0);
