#!/usr/bin/env tsx
/**
 * Preflight: does this machine have the replica set the durability sections need?
 *
 * Runs first in `check:all` so a missing replica set costs two seconds and one
 * clear message, instead of surfacing forty checks later — or, as it did until
 * now, not surfacing at all: every durability section skipped itself and the
 * gate still exited 0.
 *
 * Under `REQUIRE_RS=1` (what `check:all` sets) the absence is a failure.
 * Without it this is a report: a developer with no Docker and no local Mongo
 * still runs every deterministic section.
 *
 * Run: npx tsx src/mastra/scripts/check-replica-set.ts
 */
import { EPHEMERAL_RS_URI, findReplicaSet, replicaSetRequired, safeUri } from './lib/replica-set.js';

async function main(): Promise<void> {
  console.log('check:replica-set');

  const found = await findReplicaSet();
  if (found.uri) {
    console.log(`  ✓ replica set "${found.setName}" at ${safeUri(found.uri)} — durability sections will run`);
    if (found.uri !== EPHEMERAL_RS_URI) {
      // Worth saying out loud: this is very likely the application's own mongod,
      // which runs near a 1024 open-file soft limit. Every throwaway
      // orchestration database costs ~70 handles, so a long run of durability
      // sections there can panic WiredTiger and take the database down.
      console.log('  · not the isolated spike replica set — `npm run spike:mongo-rs:up` keeps test');
      console.log('    databases off the application\'s mongod (and its open-file budget)');
    }
    process.exit(0);
  }

  for (const probe of found.probes) {
    console.log(`  · ${safeUri(probe.uri)} → ${probe.reason ?? 'unusable'}`);
  }

  if (replicaSetRequired()) {
    console.error('  ✗ REQUIRE_RS=1 and no replica set answered — the durable half of the suite cannot run.');
    console.error('    fix: npm run spike:mongo-rs:up   (or point MONGODB_URI_V2 at a replica set)');
    process.exit(1);
  }

  console.log('  ⚠ no replica set — durability sections will SKIP. Run: npm run spike:mongo-rs:up');
  process.exit(0);
}

main().catch((error) => {
  console.error(`check failed: ${(error as Error).message}`);
  process.exit(1);
});
