#!/usr/bin/env tsx
/**
 * warm:code-index — embed the repository's code chunks OFFLINE, before an agent
 * needs them.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * `code_search` embeds on demand and caches durably, so the FIRST search after a
 * cold start pays for the whole repository. Measured on the coding canary: one
 * `code_search` call ran for roughly forty minutes and the attempt died under a
 * wall clock that could not tell work from a hang (Z9). The tool was then capped
 * at `MAX_EMBEDS_PER_CALL` chunks per call and made to report `indexWarming`,
 * which stops the run dying — but it leaves the agent doing the warm-up in
 * pieces, mid-task, while a human waits.
 *
 * Measured again 2026-08-17: `code_embed_stats` reported `totalChunks: 0`. The
 * index has simply never been built.
 *
 * This runs the same durable cache as the tool, in a loop, outside any run: no
 * budget, no liveness, nobody waiting.
 *
 *   npm run warm:code-index
 *
 * Safe to interrupt and re-run — every pass keeps what it embedded.
 */
import 'dotenv/config';

import { ensureCodeChunks } from '../tools/dev/code-search-tools.js';
import { AGENTIC_AGENTS_REPO } from '../workspaces/code-workspace.js';

const repoPath = process.argv[2] ?? AGENTIC_AGENTS_REPO;
const startedAt = Date.now();

console.log(`warm:code-index — ${repoPath}`);

let pass = 0;
let lastDeferred = Number.POSITIVE_INFINITY;

for (;;) {
  pass += 1;
  const result = await ensureCodeChunks(repoPath, { embed: true });
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `  pass ${pass}: embedded=${result.embedded} cached=${result.cached} `
    + `deferred=${result.deferred} total=${result.total} (${elapsed}s)`,
  );

  if (result.deferred === 0) {
    console.log(`\n✅ index warm: ${result.total} chunks, ${elapsed}s`);
    break;
  }
  // Stop rather than spin: if a pass defers as much as the one before it, the
  // budget is not the thing holding it back and a loop would run forever.
  if (result.deferred >= lastDeferred) {
    console.error(
      `\n⚠️  no progress (deferred ${result.deferred} after ${lastDeferred}) — stopping.`
      + ' Check the embedding provider before re-running.',
    );
    process.exit(1);
  }
  lastDeferred = result.deferred;
}

process.exit(0);
