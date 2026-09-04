#!/usr/bin/env tsx
/**
 * graph-trend-step.ts — Phase 2 Stream C step.
 *
 * 1. Backfills trend history from existing daily snapshot dirs if needed.
 * 2. Records current graph state into src/mastra/graphify-out/trend.jsonl.
 * 3. Prunes snapshot directories older than retention days (default 7).
 */

import {
  backfillGraphTrendFromSnapshots,
  recordCurrentGraphTrend,
  pruneGraphSnapshots,
  readGraphTrendEntries,
} from '../services/graphify-trend.js';

async function main() {
  console.log('── Graphify Trend & Retention Step ──');

  // Always attempted: idempotent (skips dates already recorded), so there is no
  // flag-gated variant worth having — a no-op backfill costs one directory scan.
  const bf = await backfillGraphTrendFromSnapshots();
  if (bf.added > 0) {
    console.log(`✓ Backfilled ${bf.added} historical snapshot entries into trend.jsonl (out of ${bf.processed} dirs)`);
  }

  const recordRes = await recordCurrentGraphTrend();
  if (recordRes.ok && recordRes.entry) {
    console.log(`✓ Recorded trend entry: date=${recordRes.entry.date}, commit=${recordRes.entry.commit.slice(0, 7)}, nodes=${recordRes.entry.nodes}, links=${recordRes.entry.links}, communities=${recordRes.entry.communities}`);
  } else {
    console.log(`ℹ Trend record skipped or already present: ${recordRes.reason ?? 'unchanged'}`);
  }

  const entries = readGraphTrendEntries();
  console.log(`✓ Total trend records in trend.jsonl: ${entries.length}`);

  const pruneRes = pruneGraphSnapshots();
  if (pruneRes.pruned.length > 0) {
    console.log(`✓ Pruned ${pruneRes.pruned.length} old snapshot dir(s): ${pruneRes.pruned.join(', ')}`);
  }
  console.log(`✓ Kept ${pruneRes.kept.length} recent snapshot dir(s): ${pruneRes.kept.join(', ')}`);

  console.log('✅ Graphify trend step completed.');
}

main().catch((err) => {
  console.error('⚠ graph-trend-step failed (fail-soft):', (err as Error).message);
  process.exit(0); // Fail-soft: never block caller or git hooks
});
