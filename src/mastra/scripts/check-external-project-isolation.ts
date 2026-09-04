#!/usr/bin/env tsx
/**
 * check:external-project-isolation — the SECOND mode of the coding domain.
 *
 * The coding agent has two jobs and they have opposite shapes:
 *
 *   OWN CODE (autoheal, building itself new tools) — the live repository is
 *     read-only, writes go through a per-task git worktree, commands come from an
 *     allowlist, and reaching production means blue-green with a canary. All of
 *     that exists because the agent is editing the runtime it is running inside.
 *
 *   A NEW PROJECT (`/projekty/agent-projects/<name>`) — none of that applies.
 *     There is no worktree, no canary and no promotion: it is somebody else's
 *     repository, the agent may commit into it freely, and the only thing that
 *     matters is that it CANNOT reach back into the agent's own code.
 *
 * So this gate asserts the one invariant the second mode actually rests on:
 * confinement. It is not a hypothetical — the guard had a real hole (below), and
 * nothing tested it.
 *
 * Run: npx tsx src/mastra/scripts/check-external-project-isolation.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkPathInsideRoot } from '../lib/path-containment.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';

let failures = 0;
function ok(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

console.log('check:external-project-isolation');

const PROJECT = '/projekty/agent-projects/app';

ok('REGRESSION: a sibling directory that merely EXTENDS the name is outside', () => {
  // The defect. `resolve('/…/app', '../app-evil/x.ts')` gives
  // `/…/app-evil/x.ts`, which `.startsWith('/…/app')` accepts — so the guard
  // held against the escape someone thought about (`../../mastra-agentic-…`)
  // and let through the one nobody did.
  assert.equal(checkPathInsideRoot(`${PROJECT}-evil/x.ts`, PROJECT).inside, false);
  assert.equal(checkPathInsideRoot('../app-evil/x.ts', PROJECT).inside, false);
});

ok('a path inside the project is inside, and the project itself is too', () => {
  assert.equal(checkPathInsideRoot('src/index.ts', PROJECT).inside, true);
  assert.equal(checkPathInsideRoot(`${PROJECT}/src/deep/a.ts`, PROJECT).inside, true);
  assert.equal(checkPathInsideRoot(PROJECT, PROJECT).inside, true);
});

ok('the agent\'s OWN repository is never inside an external project', () => {
  // The invariant the whole second mode rests on: work on somebody else's app
  // must not be able to edit the runtime this system is executing.
  assert.equal(checkPathInsideRoot(`${AGENTIC_AGENTS_REPO}/src/mastra/index.ts`, PROJECT).inside, false);
  assert.equal(
    checkPathInsideRoot('../../mastra-agentic-environment/agentic-agents/src/mastra/index.ts', PROJECT).inside,
    false,
  );
  assert.equal(checkPathInsideRoot('/etc/passwd', PROJECT).inside, false);
});

ok('the write tool asks the containment question, not the prefix one', () => {
  const source = readFileSync('src/mastra/tools/dev/external-projects-tools.ts', 'utf8');
  assert.ok(source.includes('checkPathInsideRoot'),
    'the write guard must use the shared containment check');
  assert.ok(!/fullPath\.startsWith\(project\.path\)/.test(source),
    'the prefix comparison is the bug — it must not come back');
});

ok('a project cannot be created inside the agent\'s own directory', () => {
  const source = readFileSync('src/mastra/workspaces/external-project-workspace.ts', 'utf8');
  assert.ok(source.includes('/projekty/mastra-agentic-environment'),
    'creation must refuse to place a project inside the agent home');
  assert.ok(source.includes('BLOCKED'), 'and must say so rather than silently relocating');
});

ok('project names are sanitised before they reach the filesystem', () => {
  // Defence in depth: even before containment, a name cannot carry separators.
  const source = readFileSync('src/mastra/workspaces/external-project-workspace.ts', 'utf8');
  assert.ok(/replace\(\/\[\^a-z0-9-_\]\/g, '-'\)/.test(source),
    'a project name must not be able to carry `/` or `..` into a path');
});

ok('ONE containment implementation, not three', () => {
  // `harness-policy.ts` had the correct version and kept it private, which is
  // how the external tool ended up with its own broken spelling.
  const policy = readFileSync('src/mastra/services/harness-policy.ts', 'utf8');
  assert.ok(policy.includes("from '../lib/path-containment.js'"),
    'the policy must import the shared check rather than redefine it');
  assert.ok(!policy.includes('function checkPathInsideRoot'),
    'a private copy is how the two spellings diverged');
});

if (failures > 0) {
  console.error(`\n❌ check:external-project-isolation — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:external-project-isolation — work on another repo cannot reach the agent\'s own code');
process.exit(0);
