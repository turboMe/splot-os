#!/usr/bin/env tsx
/**
 * check:reviewer-budgets — a reviewer must be given a budget the size of its
 * work, and must never be offered on the planner's menu.
 *
 * Three findings from 2026-08-24, none of which had any coverage:
 *
 *  1. All three reviewers were `latencyClass: minutes` → a 300s attempt cap,
 *     which the store turns into a 296s business window. Both reviewers with
 *     real data have SUCCEEDED past it (securityReviewAgent 324s,
 *     codeReviewAgent 315s), and securityReviewAgent's three recorded failures
 *     are all `deadline` at exactly 296s, alternating with successes.
 *  2. `repo-maintenance.ts` called review with a hard `timeoutMs: 180_000` —
 *     below both — and codeReviewAgent has a matching recorded failure,
 *     "Harness LLM call timed out after 180s".
 *  3. The board marks reviewers `internal: true` and `check:coding-domain`
 *     asserts it, but the V2 capability registry never read the flag while the
 *     operator allowlist named all three — so the lane could route a user
 *     request straight to `securityReviewAgent`.
 *
 * Run: npx tsx src/mastra/scripts/check-reviewer-budgets.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { agentBoard } from '../config/agent-board.js';
import {
  ATTEMPT_CAP_BY_LATENCY,
  DEFAULT_ATTEMPT_CAP_MS,
  buildCapabilityRegistry,
  reviewAttemptCapMs,
} from '../config/capability-routing.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';

const REVIEWERS = ['codeReviewAgent', 'securityReviewAgent', 'performanceReviewAgent'] as const;
/** The longest review run actually observed to SUCCEED (securityReviewAgent). */
const OBSERVED_LONGEST_SUCCESS_MS = 324_000;

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
}

console.log('check:reviewer-budgets');

check('every reviewer gets a window longer than the longest review observed to succeed', () => {
  for (const id of REVIEWERS) {
    const cap = reviewAttemptCapMs(id);
    assert.ok(
      cap > OBSERVED_LONGEST_SUCCESS_MS,
      `${id}: window ${Math.round(cap / 1000)}s must exceed the ${OBSERVED_LONGEST_SUCCESS_MS / 1000}s a review has already taken while SUCCEEDING`,
    );
  }
});

check('the runtime (kebab) id resolves to the same window as the board id', () => {
  // `canonicalizeRuntimeAgentId` covers code-review but not the other two, so a
  // lookup by `agent.id` silently fell back to the 300s default — the bug this
  // helper exists to remove, one layer down.
  const pairs: Array<[string, string]> = [
    ['code-review-agent', 'codeReviewAgent'],
    ['security-review-agent', 'securityReviewAgent'],
    ['performance-review-agent', 'performanceReviewAgent'],
  ];
  for (const [runtimeId, boardId] of pairs) {
    assert.equal(
      reviewAttemptCapMs(runtimeId),
      reviewAttemptCapMs(boardId),
      `${runtimeId} must resolve like ${boardId}, not fall back to the default`,
    );
    assert.notEqual(
      reviewAttemptCapMs(runtimeId),
      DEFAULT_ATTEMPT_CAP_MS,
      `${runtimeId} fell back to the store default — the board lookup missed`,
    );
  }
});

check('an unknown id still gets a bound, never undefined', () => {
  assert.equal(reviewAttemptCapMs('no-such-agent'), DEFAULT_ATTEMPT_CAP_MS);
  assert.equal(reviewAttemptCapMs(undefined), DEFAULT_ATTEMPT_CAP_MS);
});

check('the review step derives its timeout instead of hard-coding one', () => {
  const source = readFileSync(join(AGENTIC_AGENTS_REPO, 'src/mastra/workflows/repo-maintenance.ts'), 'utf8');
  const reviewCall = source.slice(source.indexOf('const response = await callReview('));
  const body = reviewCall.slice(0, reviewCall.indexOf('});'));
  assert.match(body, /timeoutMs:\s*reviewAttemptCapMs\(/, 'the review call must take its budget from the board');
  assert.doesNotMatch(body, /timeoutMs:\s*\d/, 'no literal timeout may come back here');
});

check('internal reviewers are NOT on the planner menu', () => {
  const registry = buildCapabilityRegistry({
    // Exactly what the operator allowlist says today.
    allow: ['researcherAgent', 'codingAgent', ...REVIEWERS],
    isAvailable: () => true,
    defaultAgentId: 'researcherAgent',
  });
  const menu = registry.forDecider().map((e) => e.name);
  for (const id of REVIEWERS) {
    assert.ok(!menu.includes(id), `${id} is marked internal and must not be offered to the lane (menu: ${menu.join(', ')})`);
  }
  assert.ok(menu.includes('codingAgent'), 'the author must stay on the menu');
});

check('internal reviewers stay RESOLVABLE, with their budgets intact', () => {
  // Filtering the menu must not un-run them: whatever legitimately dispatches a
  // reviewer still needs resolve/attemptCap/idleFloor to answer.
  const registry = buildCapabilityRegistry({
    allow: ['researcherAgent', ...REVIEWERS],
    isAvailable: () => true,
    defaultAgentId: 'researcherAgent',
  });
  for (const id of REVIEWERS) {
    assert.equal(registry.resolve(id), id, `${id} must still resolve for dispatch`);
    assert.equal(
      registry.attemptCapMsFor(id),
      ATTEMPT_CAP_BY_LATENCY[agentBoard[id].latencyClass ?? ''],
      `${id} must keep its board-derived attempt cap`,
    );
    assert.ok((registry.idleFloorMsFor(id) ?? 0) > 0, `${id} must keep an idle floor`);
  }
});

if (failures > 0) {
  console.error(`\n❌ check:reviewer-budgets — ${failures} failure(s)`);
  process.exit(1);
}

console.log('\n✅ check:reviewer-budgets — reviewers are budgeted for the work they do, and stay off the planner menu');
process.exit(0);
