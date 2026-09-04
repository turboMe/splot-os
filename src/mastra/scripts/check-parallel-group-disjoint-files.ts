#!/usr/bin/env tsx
/**
 * check:parallel-group-disjoint-files — two code-writing subtasks targeting the
 * same file must never share a parallel group (J2 step 4).
 *
 * The dependency sorter currently ignores targetFiles. This first assertion is
 * deliberately red against the production buildParallelGroups: two independent
 * `fix` subtasks for the same path both land in group 0. The completed gate also
 * pins the approved boundary: read-read and write-read overlap stay parallel;
 * only write-write collisions are split.
 */
import assert from 'node:assert/strict';

import {
  buildParallelGroups,
  routeSubtasks,
  subtaskWritesCode,
  type RoutableSubtask,
} from '../services/smart-router.js';

function task(
  id: string,
  type: string,
  targetFiles: string[],
  dependencies: string[] = [],
): RoutableSubtask {
  return { id, type, targetFiles, dependencies };
}

function groupOf(groups: RoutableSubtask[][], id: string): number {
  return groups.findIndex((group) => group.some((subtask) => subtask.id === id));
}

console.log('check:parallel-group-disjoint-files');

const groups = buildParallelGroups([
  task('writer-A', 'fix', ['src/shared.ts']),
  task('writer-B', 'fix', ['src/shared.ts']),
]);
const groupA = groupOf(groups, 'writer-A');
const groupB = groupOf(groups, 'writer-B');
console.log(`  · same-file writers landed in groups ${groupA} and ${groupB}`);
assert.notEqual(groupA, groupB, 'two writers for src/shared.ts must not run in parallel');

const readers = buildParallelGroups([
  task('reader-A', 'test', ['src/shared.ts']),
  task('reader-B', 'test', ['src/shared.ts']),
]);
assert.equal(groupOf(readers, 'reader-A'), groupOf(readers, 'reader-B'),
  'read-read overlap must stay parallel');

const writeRead = buildParallelGroups([
  task('writer', 'fix', ['src/shared.ts']),
  task('reader', 'test', ['src/shared.ts']),
]);
assert.equal(groupOf(writeRead, 'writer'), groupOf(writeRead, 'reader'),
  'write-read overlap is the explicitly accepted risk and must stay parallel');

const disjointWriters = buildParallelGroups([
  task('writer-left', 'fix', ['src/left.ts']),
  task('writer-right', 'fix', ['src/right.ts']),
]);
assert.equal(groupOf(disjointWriters, 'writer-left'), groupOf(disjointWriters, 'writer-right'),
  'writers for disjoint files should retain useful parallelism');

const packed = buildParallelGroups([
  task('x-1', 'fix', ['src/x.ts']),
  task('x-2', 'fix', ['src/x.ts']),
  task('y-1', 'fix', ['src/y.ts']),
  task('y-2', 'fix', ['src/y.ts']),
  task('reader-x', 'test', ['src/x.ts']),
]);
assert.equal(packed.length, 2, 'four writers for two paths should pack into two safe waves');
for (const [index, group] of packed.entries()) {
  const reserved = new Set<string>();
  for (const subtask of group.filter(subtaskWritesCode)) {
    for (const file of subtask.targetFiles) {
      assert.ok(!reserved.has(file), `group ${index} has two writers for ${file}`);
      reserved.add(file);
    }
  }
}

const dependencies = buildParallelGroups([
  task('base-A', 'fix', ['src/base.ts']),
  task('base-B', 'fix', ['src/base.ts']),
  task('dependent', 'test', ['src/base.ts'], ['base-A', 'base-B']),
]);
assert.ok(
  groupOf(dependencies, 'dependent')
    > Math.max(groupOf(dependencies, 'base-A'), groupOf(dependencies, 'base-B')),
  'every subwave of one topological level must finish before its dependants',
);

const originalWarn = console.warn;
let cyclic: RoutableSubtask[][];
try {
  console.warn = () => {};
  cyclic = buildParallelGroups([
    task('cycle-A', 'fix', ['src/cycle.ts'], ['cycle-B']),
    task('cycle-B', 'fix', ['src/cycle.ts'], ['cycle-A']),
  ]);
} finally {
  console.warn = originalWarn;
}
assert.notEqual(groupOf(cyclic, 'cycle-A'), groupOf(cyclic, 'cycle-B'),
  'the circular-dependency fallback must not bypass write disjointness');

// The public router is the producer of `parallelGroup`; prove the safe grouping
// reaches that contract instead of existing only as an exported helper.
const routedTasks = [
  task('routed-A', 'fix', ['src/routed.ts']),
  task('routed-B', 'fix', ['src/routed.ts']),
];
routeSubtasks(routedTasks, false);
assert.notEqual(
  routedTasks[0]!.parallelGroup,
  routedTasks[1]!.parallelGroup,
  'routeSubtasks did not carry the split into parallelGroup',
);

console.log('check:parallel-group-disjoint-files PASSED');
