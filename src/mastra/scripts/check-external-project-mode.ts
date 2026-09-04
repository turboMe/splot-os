#!/usr/bin/env tsx
/**
 * check:external-project-mode — the coding agent's SECOND working mode: build a
 * new application in a fresh repository, with no worktree, no canary and no
 * blue-green, because none of that applies to code this system does not run.
 *
 * WHY THIS IS A SEPARATE GATE
 * ---------------------------
 * `check:external-project-isolation` asks the safety question — can a project
 * reach outside itself. This one asks the capability question: can an agent
 * actually BUILD something here. Both matter, and the second is the one that
 * fails quietly.
 *
 * Measured 2026-08-17: the containment guard correctly refused three escape
 * attempts, and then the LEGITIMATE write failed with ENOENT because
 * `writeFileSync` will not create a parent directory. A new project starts
 * empty, so the first file an agent writes is almost always nested —
 * `src/index.js`, `docs/README.md`. Refusing the attacks and the work in the
 * same breath is the combination most likely to read as "this tool is broken".
 *
 * Run: npx tsx src/mastra/scripts/check-external-project-mode.ts
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { runWithHarnessExecutionContext } from '../services/harness-execution-context.js';

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

console.log('check:external-project-mode');

const tools = await import('../tools/dev/external-projects-tools.js');
const call = <T>(fn: () => Promise<T>): Promise<T> => runWithHarnessExecutionContext(
  { agentId: 'codingAgent', runId: 'chk-ext', taskId: 'chk-ext' },
  fn as never,
) as Promise<T>;

const PROJECT = `chk-ext-${randomUUID().slice(0, 8)}`;
const NEIGHBOUR = `chk-ext-${randomUUID().slice(0, 8)}`;
let projectPath = '';
let neighbourPath = '';

await check('H1: a new project is created, with git already initialised', async () => {
  const created = await call(() => (tools as never as {
    createExternalProjectTool: { execute: (i: unknown) => Promise<{ success: boolean; path: string }> };
  }).createExternalProjectTool.execute({ projectName: PROJECT, description: 'gate probe' }));
  assert.equal(created.success, true, 'creating a project must succeed');
  projectPath = created.path;
  assert.ok(existsSync(projectPath), 'and the directory must exist');

  const neighbour = await call(() => (tools as never as {
    createExternalProjectTool: { execute: (i: unknown) => Promise<{ success: boolean; path: string }> };
  }).createExternalProjectTool.execute({ projectName: NEIGHBOUR, description: 'gate probe' }));
  neighbourPath = neighbour.path;
});

await check('H2: the FIRST file an agent writes is nested, and that must work', async () => {
  // The defect this gate exists for. A fresh project has no `src/`, and
  // `writeFileSync` answers a missing directory with ENOENT.
  const written = await call(() => (tools as never as {
    writeExternalProjectFileTool: { execute: (i: unknown) => Promise<{ success: boolean; error?: string }> };
  }).writeExternalProjectFileTool.execute({
    projectName: PROJECT, filePath: 'src/index.js', content: 'console.log("hi");\n',
  }));
  assert.equal(written.success, true, `a nested first write must succeed, got: ${written.error}`);
  assert.equal(
    readFileSync(join(projectPath, 'src/index.js'), 'utf-8').trim(),
    'console.log("hi");',
    'and the content must actually be on disk',
  );
});

await check('H2: a project cannot write into its NEIGHBOUR', async () => {
  // The safety half, asked the way it actually matters: not "can it reach /etc",
  // but "can one piece of work corrupt another".
  for (const filePath of [
    `../${NEIGHBOUR}/injected.txt`,
    `../../agent-projects/${NEIGHBOUR}/injected.txt`,
    '/tmp/chk-ext-injected',
  ]) {
    const result = await call(() => (tools as never as {
      writeExternalProjectFileTool: { execute: (i: unknown) => Promise<{ success: boolean; error?: string }> };
    }).writeExternalProjectFileTool.execute({ projectName: PROJECT, filePath, content: 'x' }));
    assert.equal(result.success, false, `${filePath} must be refused`);
    assert.match(String(result.error), /escape/i, 'and the refusal must say why');
  }
  assert.ok(!existsSync(join(neighbourPath, 'injected.txt')), 'nothing may have landed next door');
  assert.ok(!existsSync('/tmp/chk-ext-injected'), 'and nothing outside the root');
});

await check('H3: arbitrary commands run, including a real git commit', async () => {
  // This is the whole point of the second mode: no worktree, no approval gate,
  // no blue-green — the agent commits to the repository it just created, because
  // that repository is not the one this system runs from.
  const run = (command: string) => call(() => (tools as never as {
    runExternalProjectCommandTool: {
      execute: (i: unknown) => Promise<{ success: boolean; output?: string; error?: string }>;
    };
  }).runExternalProjectCommandTool.execute({ projectName: PROJECT, command }));

  const node = await run('node src/index.js');
  assert.equal(node.success, true, `running the file it just wrote must work: ${node.error}`);
  assert.match(String(node.output), /hi/, 'and its output must come back');

  const committed = await run(
    'git add -A && git -c user.email=a@b -c user.name=a commit -q -m "first" && git log --oneline',
  );
  assert.equal(committed.success, true, `committing in its OWN repo must work: ${committed.error}`);
  assert.match(String(committed.output), /first/, 'and the commit must be in the log');
});

await check('H5: the project is discoverable afterwards', async () => {
  const listed = await call(() => (tools as never as {
    listExternalProjectsTool: {
      execute: (i: unknown) => Promise<{ success: boolean; projects: Array<{ name: string; hasGit: boolean }> }>;
    };
  }).listExternalProjectsTool.execute({}));
  assert.equal(listed.success, true);
  const mine = listed.projects.find((p) => p.name === PROJECT);
  assert.ok(mine, 'an agent must be able to find the project it built');
  assert.equal(mine!.hasGit, true, 'and see that it has a repository');
});

await check('the gate leaves no projects behind', () => {
  for (const path of [projectPath, neighbourPath]) {
    if (path && existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
  assert.ok(!existsSync(projectPath), 'the probe project is gone');
  assert.ok(!existsSync(neighbourPath), 'and so is its neighbour');
});

if (failures > 0) {
  console.error(`\n❌ check:external-project-mode — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:external-project-mode — an agent can build in a fresh repo, and only in it');
process.exit(0);
