#!/usr/bin/env tsx
/**
 * check:workspace-bm25 (A12) — `bm25: true` + `autoIndexPaths` on
 * codeWorkspace were declared and wired since before this session, but never
 * exercised on their own (`docs/MIGRACJA-DOMENY-CODING.md` A12).
 *
 * NOT against the real `codeWorkspace`: its `autoIndexPaths` covers
 * `src/mastra` in full — 3099 files, ~657MB, measured live 2026-08-23 to take
 * well over 3 minutes to `init()`. That is a real fact about the production
 * configuration (see the audit note this check's commit references), but
 * paying that cost on every `check:all` run would make the gate itself the
 * slow thing. This proves the SAME mechanism — `Workspace({ bm25: true,
 * autoIndexPaths })`, `.init()`, `mastra_workspace_search` — against a small,
 * real slice of this repo (`src/mastra/config`, ~260KB) that indexes in
 * milliseconds. What's being proven is "does BM25 search actually work end to
 * end", not "does codeWorkspace's specific file list index fast" — those are
 * different claims, and only the first one belongs in a routine gate.
 *
 * Run: npx tsx src/mastra/scripts/check-workspace-bm25.ts
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Workspace, LocalFilesystem, createWorkspaceTools } from '@mastra/core/workspace';

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

console.log('check:workspace-bm25');

const probeWorkspace = new Workspace({
  id: 'check-workspace-bm25-probe',
  name: 'BM25 probe (src/mastra/config slice)',
  filesystem: new LocalFilesystem({
    basePath: resolve(process.cwd(), 'src/mastra/config'),
    contained: true,
    readOnly: true,
  }),
  bm25: true,
  autoIndexPaths: ['.'],
});

await check('init() actually indexes the configured paths (real files, not a fixture)', async () => {
  const t0 = Date.now();
  await probeWorkspace.init();
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 30_000, `a small real directory must index in well under 30s (took ${elapsedMs}ms)`);
});

const tools = await createWorkspaceTools(probeWorkspace);

await check('mastra_workspace_search is actually exposed after bm25: true', () => {
  assert.ok(tools['mastra_workspace_search'], 'a bm25-enabled workspace must expose its search tool');
});

await check('a real query returns a real, relevant chunk from a real file — not zero results', async () => {
  const result = await tools['mastra_workspace_search'].execute(
    { query: 'resolvePhaseTools activeTools allowlist' },
    {} as never,
  );
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  assert.doesNotMatch(text, /^"?0 results/, 'a query matching real indexed content must not return zero results');
  assert.match(text, /pipeline-phase-tools\.ts/, 'the top result must be the real file that actually defines resolvePhaseTools');
  assert.match(text, /alwaysAvailable|statusTool/, 'the returned chunk must contain real surrounding content, not just a filename');
});

await check('a query with no real match returns zero results honestly, not a fabricated hit', async () => {
  const result = await tools['mastra_workspace_search'].execute(
    { query: 'zzz_totally_unrelated_term_xyz_nonexistent_qqq' },
    {} as never,
  );
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  assert.match(text, /0 results/, 'an unmatched query must honestly report zero results');
});

if (failures > 0) {
  console.error(`\n❌ check:workspace-bm25 — ${failures} failure(s)`);
  process.exit(1);
}

console.log('\n✅ check:workspace-bm25 — bm25 indexing and search work end to end against real files');
process.exit(0);
