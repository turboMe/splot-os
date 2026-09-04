#!/usr/bin/env tsx
/**
 * check:dispatch-concurrency-cap — one parallel group must not launch every
 * subtask at once (J2 step 3).
 *
 * The old production path used `Promise.allSettled(group.subtasks.map())`. A
 * group of nine cloud file-editors therefore created nine simultaneous model
 * calls; VramBudgetTracker could not help because the repair model is
 * cloud-pinned. The approved per-dispatch wave cap is 3 by default.
 *
 * The gate keeps that old shape as a falsification control: it MUST still peak
 * at nine, or the workload did not overlap and a green cap measurement would
 * prove nothing. It then applies the same workload to the production helper.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ITEMS = Array.from({ length: 9 }, (_, index) => index);
const LIMIT = 3;

async function measurePeak(
  run: (fn: (item: number) => Promise<number>) => Promise<unknown>,
): Promise<number> {
  let active = 0;
  let peak = 0;
  await run(async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
    return item;
  });
  return peak;
}

console.log('check:dispatch-concurrency-cap');

const dispatchSource = readFileSync('src/mastra/services/parallel-dispatch.ts', 'utf8');
const legacyPeak = await measurePeak((fn) => Promise.allSettled(ITEMS.map(fn)));
console.log(`  · old unbounded shape peak=${legacyPeak}`);
assert.equal(
  legacyPeak,
  ITEMS.length,
  'falsification control did not overlap every item, so this run proves nothing',
);

const {
  DEFAULT_DISPATCH_CONCURRENCY,
  resolveDispatchConcurrency,
  runWithConcurrency,
} = await import('../services/parallel-dispatch.js');

const peak = await measurePeak((fn) => runWithConcurrency(ITEMS, LIMIT, fn));
console.log(`  · bounded production helper peak=${peak}, configured limit=${LIMIT}`);
assert.ok(peak <= LIMIT, `dispatch concurrency exceeded ${LIMIT}: peak=${peak}`);
assert.equal(peak, LIMIT, 'the worker pool should use the available wave without exceeding it');

const settled = await runWithConcurrency(ITEMS.slice(0, 6), 2, async (item) => {
  await new Promise((resolve) => setTimeout(resolve, (6 - item) * 2));
  if (item === 2) throw new Error('intentional subtask failure');
  return `value-${item}`;
});
assert.equal(settled.length, 6, 'one rejection must not hide any subtask result');
assert.deepEqual(
  settled.map((result) => result.status),
  ['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled'],
  'allSettled statuses must stay aligned with input indexes',
);
assert.equal(settled[0]?.status === 'fulfilled' ? settled[0].value : undefined, 'value-0');
assert.match(
  String(settled[2]?.status === 'rejected' ? settled[2].reason : ''),
  /intentional subtask failure/,
);
assert.equal(settled[5]?.status === 'fulfilled' ? settled[5].value : undefined, 'value-5');
assert.deepEqual(await runWithConcurrency([], LIMIT, async (item) => item), []);

assert.equal(resolveDispatchConcurrency(undefined), DEFAULT_DISPATCH_CONCURRENCY);
assert.equal(resolveDispatchConcurrency('4'), 4);
for (const invalid of ['', '0', '-2', '2.5', 'not-a-number']) {
  assert.equal(
    resolveDispatchConcurrency(invalid),
    DEFAULT_DISPATCH_CONCURRENCY,
    `${JSON.stringify(invalid)} must fall back to the approved default`,
  );
}

assert.doesNotMatch(
  dispatchSource,
  /Promise\.allSettled\(\s*group\.subtasks\.map/,
  'dispatch regressed to unbounded fan-out',
);
assert.match(
  dispatchSource,
  /runWithConcurrency\(\s*group\.subtasks,\s*dispatchConcurrency,/,
  'the bounded helper exists but dispatch does not use it',
);
assert.match(
  dispatchSource,
  /resolveDispatchConcurrency\(\)/,
  'dispatch ignores J2_DISPATCH_CONCURRENCY',
);

console.log('check:dispatch-concurrency-cap PASSED');
