#!/usr/bin/env tsx
/**
 * check:review-verdict-freshness — a review pass that never submitted a
 * verdict must not be read as though it had (Z38).
 *
 * WHY THIS IS A GATE AND NOT A CODE REVIEW NOTE
 * ----------------------------------------------
 * `repo-maintenance.ts` calls the review agent, then reads
 * `artifact.reviewVerdict` back out of Mongo — twice: once from
 * `execute-review-agent`, once from `decisionGate`'s internal rework loop.
 * `generateWithHarness` has its own model-fallback chain, and a fallback
 * model can come back with pure prose and ZERO tool calls — it never calls
 * `submitReviewTool`. Measured live 2026-08-23 (F2 canary, taskId
 * `f2-live-merge-2026-08-23`): iteration 1 correctly said `needs_changes`
 * (the file really was missing); the rework fix actually landed on disk;
 * the re-review's primary model (`custom-deepseek/deepseek-v4-pro`) failed
 * to resolve, fell back to `gemini-2.5-flash`, which replied
 * `steps=1, toolCalls=0, toolResults=0` — never touching
 * `submitReviewTool`. The code used to read `reviewVerdict` from Mongo
 * regardless and get back iteration 1's stale `needs_changes`, reporting
 * `loop_back` as if a fresh review had rejected the fix. No error, no
 * trace that the review never actually ran.
 *
 * THE RULE: a verdict is only trustworthy if `coding_submit_review` was
 * actually called during THIS pass. `runReviewAndGetVerdict` in
 * `repo-maintenance.ts` checks this by comparing the count of `[REVIEW]`
 * entries in the artifact's `plan` array before/after the call (the same
 * marker `submitReviewTool` writes and `review-precontext.ts` already
 * reads), retries once, and throws rather than return a stale verdict if
 * the tool is still never called.
 *
 * Run: npx tsx src/mastra/scripts/check-review-verdict-freshness.ts
 */
import assert from 'node:assert/strict';
import {
  countReviewEntries,
  runReviewAndGetVerdict,
} from '../workflows/repo-maintenance.js';
import type { Agent } from '@mastra/core/agent';
import type { getDb } from '../lib/mongo.js';

type FakeDb = Awaited<ReturnType<typeof getDb>>;

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

console.log('check:review-verdict-freshness');

// ── A minimal fake of the Mongo surface runReviewAndGetVerdict touches ──
type FakeDoc = { taskId: string; plan: string[]; reviewVerdict?: string };
function makeFakeDb(seed: FakeDoc) {
  const store = new Map<string, FakeDoc>([[seed.taskId, { ...seed, plan: [...seed.plan] }]]);
  const fake = {
    collection: (_name: string) => ({
      findOne: async (query: { taskId: string }) => store.get(query.taskId) ?? null,
    }),
    // test-only hook to mutate the fake store, standing in for what a real
    // submitReviewTool call would have written to Mongo
    _writeVerdict(taskId: string, verdict: string, summary: string): void {
      const doc = store.get(taskId);
      if (!doc) throw new Error('fake doc missing');
      doc.plan.push(`[REVIEW] ${verdict}: ${summary}`);
      doc.reviewVerdict = verdict;
    },
  };
  return fake;
}
/** Cast at the call boundary only, so `_writeVerdict` stays visible on the fake. */
const asDb = (fake: ReturnType<typeof makeFakeDb>): FakeDb => fake as unknown as FakeDb;

const fakeAgent = {} as Agent;
const fakeResponse = {
  runId: 'r', turnId: 't', response: undefined, promptHash: 'h',
  outputPreview: 'fake review text', deliverableText: '', durationMs: 1, eventsWritten: 0,
};

check('countReviewEntries counts only [REVIEW] plan entries', () => {
  assert.equal(countReviewEntries(null), 0);
  assert.equal(countReviewEntries({ plan: ['[REVIEW] approve: x', 'not a review', '[REVIEW] block: y'] }), 2);
  assert.equal(countReviewEntries({ plan: [] }), 0);
});

await check(
  'a review pass that calls coding_submit_review is trusted immediately (no spurious retry)',
  async () => {
    const db = makeFakeDb({ taskId: 't1', plan: [] });
    let calls = 0;
    const result = await runReviewAndGetVerdict({
      agent: fakeAgent, taskId: 't1', threadId: 't1', reviewIteration: 1, db: asDb(db),
      buildPrompt: () => 'prompt',
      callReview: async () => {
        calls += 1;
        db._writeVerdict('t1', 'approve', 'looks good');
        return fakeResponse as any;
      },
    });
    assert.equal(calls, 1, 'must not retry when the tool was actually called');
    assert.equal(result.verdict, 'approve');
  },
);

await check(
  'Z38 reproduced: a zero-tool-call pass on a STALE-verdict artifact must not be read as fresh — it recovers on retry',
  async () => {
    // Seeds exactly the live failure: iteration 1 already wrote needs_changes.
    const db = makeFakeDb({ taskId: 't2', plan: ['[REVIEW] needs_changes: file missing'], reviewVerdict: 'needs_changes' });
    let calls = 0;
    const result = await runReviewAndGetVerdict({
      agent: fakeAgent, taskId: 't2', threadId: 't2', reviewIteration: 2, db: asDb(db),
      buildPrompt: () => 'prompt',
      callReview: async () => {
        calls += 1;
        // First call: the broken-model fallback — prose, zero tool calls,
        // nothing written. Second call (retry): recovers and approves.
        if (calls === 2) db._writeVerdict('t2', 'approve', 'fixed now');
        return fakeResponse as any;
      },
    });
    assert.equal(calls, 2, 'must retry exactly once after a zero-tool-call pass');
    assert.equal(
      result.verdict,
      'approve',
      'the OLD bug would have returned the stale needs_changes from iteration 1 without ever retrying',
    );
  },
);

await check(
  'a review that never calls coding_submit_review across both attempts fails loudly, not silently',
  async () => {
    const db = makeFakeDb({ taskId: 't3', plan: ['[REVIEW] needs_changes: file missing'], reviewVerdict: 'needs_changes' });
    let calls = 0;
    await assert.rejects(
      () => runReviewAndGetVerdict({
        agent: fakeAgent, taskId: 't3', threadId: 't3', reviewIteration: 2, db: asDb(db),
        buildPrompt: () => 'prompt',
        callReview: async () => { calls += 1; return fakeResponse as any; },
      }),
      /code review did not run/,
    );
    assert.equal(calls, 2, 'must have tried exactly twice before giving up');
  },
);

if (failures > 0) {
  console.error(`\n❌ check:review-verdict-freshness — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:review-verdict-freshness — a silent-fallback review can no longer masquerade as a fresh verdict');
process.exit(0);
