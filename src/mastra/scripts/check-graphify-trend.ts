#!/usr/bin/env tsx
/**
 * check-graphify-trend.ts — Verification for Graphify Trend & Retention (Phase 2 Stream C).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  extractGraphTrendSummary,
  readGraphTrendEntries,
  appendGraphTrendEntry,
  pruneGraphSnapshots,
  defaultTrendPath,
  type GraphTrendEntry,
} from '../services/graphify-trend.js';

async function main() {
  console.log('check:graphify-trend');

  // 1. Verify trend.jsonl exists and contains valid entries
  const trendPath = defaultTrendPath();
  assert.ok(existsSync(trendPath), 'trend.jsonl should exist after trend step');
  const entries = readGraphTrendEntries(trendPath);
  assert.ok(entries.length > 0, `trend.jsonl should contain entries, found ${entries.length}`);

  const sample = entries[0]!;
  assert.ok(typeof sample.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sample.date), 'date must be YYYY-MM-DD');
  assert.ok(typeof sample.nodes === 'number' && sample.nodes > 0, 'nodes must be positive number');
  assert.ok(typeof sample.links === 'number' && sample.links > 0, 'links must be positive number');
  assert.ok(typeof sample.communities === 'number' && sample.communities > 0, 'communities must be positive number');
  assert.ok(Array.isArray(sample.top_god_nodes) && sample.top_god_nodes.length > 0, 'top_god_nodes must be non-empty array');
  console.log(`  ✓ Read ${entries.length} valid trend records from trend.jsonl`);

  // 2. Test append and idempotency on a temporary trend file
  const testTmpDir = resolve(process.cwd(), 'src', 'mastra', 'graphify-out', '.test-tmp');
  const testTrendFile = resolve(testTmpDir, 'test-trend.jsonl');
  rmSync(testTmpDir, { recursive: true, force: true });
  mkdirSync(testTmpDir, { recursive: true });

  const dummyEntry: GraphTrendEntry = {
    date: '2026-08-26',
    commit: 'testcommit123',
    nodes: 100,
    links: 200,
    communities: 10,
    top_god_nodes: [{ label: 'testNode', edges: 50 }],
  };

  const res1 = appendGraphTrendEntry(dummyEntry, testTrendFile);
  assert.equal(res1.appended, true, 'first append should succeed');

  const res2 = appendGraphTrendEntry(dummyEntry, testTrendFile);
  assert.equal(res2.appended, false, 'duplicate identical entry append should be skipped');

  const readBack = readGraphTrendEntries(testTrendFile);
  assert.equal(readBack.length, 1, 'should have exactly 1 record');
  assert.equal(readBack[0]!.commit, 'testcommit123');
  console.log('  ✓ Append and duplicate suppression verified');

  // 3. Test negative case: missing / invalid graph file -> fail-soft (returns null)
  const invalidSummary = await extractGraphTrendSummary({ graphPath: '/non/existent/path/graph.json' });
  assert.equal(invalidSummary, null, 'extractGraphTrendSummary must return null for missing graph');

  const badJsonPath = resolve(testTmpDir, 'corrupted-graph.json');
  writeFileSync(badJsonPath, 'invalid json content!!!', 'utf8');
  const corruptedSummary = await extractGraphTrendSummary({ graphPath: badJsonPath });
  assert.equal(corruptedSummary, null, 'extractGraphTrendSummary must return null for corrupted json');
  console.log('  ✓ Negative tests (missing file, corrupted file) handled fail-soft');

  // 4. Test retention pruning logic on mock directory structure
  const mockBase = resolve(testTmpDir, 'mock-graphify-out');
  mkdirSync(resolve(mockBase, '2026-08-01'), { recursive: true });
  mkdirSync(resolve(mockBase, '2026-08-20'), { recursive: true });
  mkdirSync(resolve(mockBase, '2026-08-26'), { recursive: true });

  const pruneResult = pruneGraphSnapshots({
    baseDir: mockBase,
    retentionDays: 5,
    nowDate: '2026-08-26',
  });

  assert.ok(pruneResult.pruned.includes('2026-08-01'), '2026-08-01 should be pruned (older than 5 days)');
  assert.ok(pruneResult.pruned.includes('2026-08-20'), '2026-08-20 should be pruned (older than 5 days)');
  assert.ok(pruneResult.kept.includes('2026-08-26'), '2026-08-26 should be kept');
  console.log('  ✓ Retention pruning correctly purged old dates and kept recent dates');

  // Clean up test temp
  rmSync(testTmpDir, { recursive: true, force: true });

  console.log('\n✅ check:graphify-trend — all assertions passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ check:graphify-trend failed:', err);
  process.exit(1);
});
