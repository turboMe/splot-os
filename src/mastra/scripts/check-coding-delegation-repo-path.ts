#!/usr/bin/env tsx
/**
 * check:coding-delegation-repo-path — an external-project brief does not get
 * handed a map of the wrong repository.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * `delegate-task.ts` passed `repoPath: AGENTIC_AGENTS_REPO` unconditionally to
 * every codingAgent delegation, sync or async. Mode selection (own repo vs. an
 * external project under `/projekty/agent-projects/<name>`) is prompt-only —
 * nothing upstream routes on it (`coding/base.md` §1) — so a brief that is
 * unambiguously about an external project still got this agent's OWN repo map
 * and task checkpoint injected into its precontext: wasted context budget, and
 * a "here is the repository" frame on a task that isn't about this repository.
 *
 * WHAT THE FIX IS: `repoPathForCodingDelegation` fires ONLY on an unambiguous
 * signal (the real external-projects path, or the exact upstream contract
 * name `createExternalProject(`) and returns `''` — not `undefined` — because
 * both `generateCoding` and `startAsyncDelegation` fall back to
 * `AGENTIC_AGENTS_REPO` with `??`, which treats `undefined` as "caller didn't
 * say" and refills it (the default V2's own callers rely on, Z6). `??` does
 * not treat `''` as nullish, so the empty string survives that fallback and
 * reaches `buildCodingPrecontext`, which already suppresses the repo-map and
 * checkpoint sections gracefully for a missing repoPath.
 *
 * Deliberately narrow: a brief that merely mentions "external" or "new
 * project" in passing (plausible for capability-build work too) still gets
 * the own-repo default — that is today's behaviour, not a regression, and a
 * wrong suppression would starve a real self-repair task of its repo map.
 *
 * Run: npx tsx src/mastra/scripts/check-coding-delegation-repo-path.ts
 */
import assert from 'node:assert/strict';
import { repoPathForCodingDelegation } from '../tools/system/delegate-task.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';
import { buildCodingPrecontext } from '../services/coding-precontext.js';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
}

console.log('check:coding-delegation-repo-path');

// ── 1. The classifier itself ───────────────────────────────────────────────

await check('an ordinary self-repair brief still gets the own repo', () => {
  assert.equal(
    repoPathForCodingDelegation('Fix the failing check:all section in artifact-tools.ts.'),
    AGENTIC_AGENTS_REPO,
  );
});

await check('an explicit external-projects path suppresses the own repo', () => {
  assert.equal(
    repoPathForCodingDelegation('Build a new app at /projekty/agent-projects/my-app with a REST API.'),
    '',
  );
});

await check('the exact upstream contract name suppresses the own repo', () => {
  assert.equal(
    repoPathForCodingDelegation('Use createExternalProject(name, "typescript") to scaffold this.'),
    '',
  );
});

await check('a vague "external"/"new project" mention alone does NOT suppress', () => {
  // Capability-build briefs also talk about "new" things without meaning
  // "outside this repo" — the classifier must not overreach on vocabulary.
  assert.equal(
    repoPathForCodingDelegation('This is a brand new capability, external to what exists today.'),
    AGENTIC_AGENTS_REPO,
    'an unrelated use of "new"/"external" must not be read as a mode-2 signal',
  );
});

// ── 2. The empty string actually reaches and survives the real precontext ──

await check('repoPath="" reaches buildCodingPrecontext as a real missing repo, not a silently-refilled default', async () => {
  const result = await buildCodingPrecontext({
    userPrompt: 'build something in an external project',
    repoPath: '',
    includeRepoMap: true,
    includeCheckpoint: true,
  });
  assert.ok(result.suppressedReasons.includes('repoPath_missing'),
    'an empty repoPath must suppress the repo map/checkpoint sections exactly like no repoPath at all');
  assert.equal(result.repoMapIncluded, false);
  assert.equal(result.checkpointIncluded, false);
});

await check('a real repoPath still builds the repo map (no over-suppression)', async () => {
  const result = await buildCodingPrecontext({
    userPrompt: 'fix a bug',
    repoPath: AGENTIC_AGENTS_REPO,
    includeRepoMap: true,
    includeCheckpoint: true,
  });
  assert.ok(!result.suppressedReasons.includes('repoPath_missing'),
    'a genuine repoPath must not be treated as missing');
});

// ── 3. FALSIFY: prove '' actually differs from the old unconditional default ─

await check('FALSIFIED: the pre-fix behaviour really did hand every brief the own repo', () => {
  const preFixRepoPath = AGENTIC_AGENTS_REPO; // what every call site used to pass, unconditionally
  assert.notEqual(
    repoPathForCodingDelegation('Build a new app at /projekty/agent-projects/my-app with a REST API.'),
    preFixRepoPath,
    'sanity check: the fixed classifier must actually diverge from the old constant for this brief, ' +
    'or this suite would be proving nothing',
  );
});

console.log(failures === 0 ? '\n✅ check:coding-delegation-repo-path — all assertions passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
