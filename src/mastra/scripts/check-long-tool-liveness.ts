#!/usr/bin/env tsx
/**
 * check:long-tool-liveness — a tool that is WORKING must say so, and must not
 * turn one question into an indexing job.
 *
 * MEASURED, NOT IMAGINED (coding canary, 2026-08-12)
 * ---------------------------------------------------
 * The first `code_search` in this repository met a cold embedding cache and
 * started embedding the whole tree inside ONE tool call, at ~10 chunks/s. It was
 * working the entire time — the counter climbed 1410 → 2711 while it ran — but a
 * tool call emits no liveness event, so the watchdog saw eight minutes of
 * silence, cut the attempt, and the retry began the same warm-up from scratch.
 *
 *     3 tasks · 3 attempts · 3 × TIMED_OUT · 0 characters of output · job FAILED
 *
 * That is exactly the failure liveness was introduced to prevent ("cut for
 * silence, never for working long"), defeated by the one case it cannot see.
 *
 * THE MECHANISM ALREADY EXISTED AND HAD NO CALLERS
 * ------------------------------------------------
 * `touchCurrentRunLiveness()` was written for precisely this, exported from
 * `run-budget.ts` — and `grep` over the whole of `src/` found zero call sites
 * outside its own definition. Built, correct, unwired: the same shape as the
 * dead artifact channel, the unreachable liveness budget and `plan_steps`.
 *
 * So this gate pins BOTH halves, because either alone leaves the failure intact:
 * the work reports itself, AND one call does a bounded slice of it.
 *
 * Run: npx tsx src/mastra/scripts/check-long-tool-liveness.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

console.log('check:long-tool-liveness');

const searchSource = readFileSync('src/mastra/tools/dev/code-search-tools.ts', 'utf8');

ok('the embedding loop reports liveness while it works', () => {
  assert.ok(searchSource.includes('touchCurrentRunLiveness'),
    'the embedding loop must touch liveness — without it a working tool looks hung');
  // Placement matters: touching once before the loop proves nothing, because the
  // watchdog measures the gap BETWEEN events.
  const loopStart = searchSource.indexOf('for (const chunk of chunks)');
  const touchAt = searchSource.indexOf('touchCurrentRunLiveness()');
  assert.ok(loopStart !== -1, 'the chunk loop must still exist');
  assert.ok(touchAt > loopStart,
    'the touch must be INSIDE the per-chunk loop, not once before it');
});

ok('one call embeds a bounded slice, not the whole repository', () => {
  assert.ok(searchSource.includes('MAX_EMBEDS_PER_CALL'),
    'a search is a question; warming the index is a job, and one call may not become the other');
  const match = searchSource.match(/const MAX_EMBEDS_PER_CALL = (\d+);/);
  assert.ok(match, 'the bound must be a named constant, not a literal buried in a condition');
  const bound = Number(match![1]);
  // Room to be useful, small enough to stay well inside the tightest idle floor
  // (60s for `seconds`-class capabilities) at the measured ~10 chunks/s.
  assert.ok(bound >= 50 && bound <= 1000, `bound ${bound} is outside a defensible range`);
});

ok('a deferred chunk is still STORED, so the warm-up makes progress', () => {
  // Dropping unembedded chunks would restart the warm-up from the same place on
  // every call — the retry loop that produced three timeouts.
  assert.ok(searchSource.includes('deferred++'),
    'chunks past the budget must be counted');
  const deferredAt = searchSource.indexOf('deferred++');
  const upsertAt = searchSource.indexOf('upsert.run(', deferredAt);
  assert.ok(upsertAt > deferredAt,
    'a deferred chunk must still reach the upsert, or the next call redoes this one');
});

ok('a partial index SAYS it is partial', () => {
  // A thin answer from a warming index is indistinguishable from "this symbol
  // does not exist" — and a model asked to assess blast radius would report the
  // second when the first is true.
  assert.ok(searchSource.includes('indexWarming'),
    'the tool must tell the model its coverage is incomplete');
  assert.ok(searchSource.includes('chunksPendingEmbedding'),
    'and how much is missing, so "search again" is an informed choice');
});

ok('the liveness helper has a caller at all', () => {
  // The regression that matters: this helper existed, was exported, and had zero
  // callers, so every long tool call in the system looked like a hang.
  const budget = readFileSync('src/mastra/services/run-budget.ts', 'utf8');
  assert.ok(budget.includes('export function touchCurrentRunLiveness'),
    'the helper must stay exported');
  assert.ok(searchSource.includes('touchCurrentRunLiveness'),
    'and must be called from at least one long-running tool');
});

if (failures > 0) {
  console.error(`\n❌ check:long-tool-liveness — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:long-tool-liveness — a long tool reports progress and bounds its own warm-up');
process.exit(0);
