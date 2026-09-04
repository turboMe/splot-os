#!/usr/bin/env tsx
/**
 * check:embedding-consistency — one embedder, one model, and every persisted
 * vector remembers which model produced it.
 *
 * WHY THIS IS WORTH A GATE
 * ------------------------
 * Vectors from two different models share a space only by coincidence. Mixing
 * them does not throw, does not log, and does not fail a test — similarity
 * search simply starts returning nonsense, and the symptom ("the agent's code
 * search got worse") points nowhere near the cause.
 *
 * There are nineteen call sites that embed something: the code index, the
 * failure brain, pattern RAG, recipe and content libraries, semantic memory.
 * They agree today because they all go through `lib/embedder.ts`. That is the
 * property worth pinning — a single new call site reaching for a provider
 * directly is how the drift starts.
 *
 * The second half is the safety net for when the model DOES change on purpose:
 * a stored vector carries its model id, and a cache entry is reused only when
 * that id still matches, so a change re-embeds rather than mixes.
 *
 * Run: npx tsx src/mastra/scripts/check-embedding-consistency.ts
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { EMBEDDING_MODEL_ID } from '../lib/embedder.js';

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

console.log('check:embedding-consistency');
console.log(`  (model: ${EMBEDDING_MODEL_ID})`);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'public' || entry === '_skills') continue;
      sourceFiles(full, acc);
    } else if (entry.endsWith('.ts') && !entry.startsWith('check-')) {
      acc.push(full);
    }
  }
  return acc;
}

const files = sourceFiles('src/mastra');

await check('every place that embeds goes through the ONE embedder', () => {
  const offenders: string[] = [];
  for (const file of files) {
    if (file.endsWith('lib/embedder.ts')) continue;
    const src = readFileSync(file, 'utf-8');
    if (!/generateEmbedding\s*\(/.test(src)) continue;
    // Static OR dynamic import: `context-assembler` imports the embedder lazily
    // on purpose, so the run degrades gracefully when it is offline rather than
    // failing at module load. Same module, same model — a narrower check flagged
    // it as a bypass, which it is not.
    const importsShared = /from '[^']*lib\/embedder(\.js)?'/.test(src)
      || /import\(\s*'[^']*lib\/embedder(\.js)?'\s*\)/.test(src);
    if (!importsShared) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

await check('nobody reaches an embedding PROVIDER directly', () => {
  // A second path to ollama or an API is how two models end up in one space.
  // Comments and tool descriptions are stripped so documenting the rule does not
  // violate it — but NOT with a bare `//` match: that also truncates every URL at
  // `http://`, which silently removed the very thing this looks for. Found by
  // falsifying: a planted `'http://localhost:11434/api/embed'` went undetected.
  const offenders: string[] = [];
  for (const file of files) {
    if (file.endsWith('lib/embedder.ts')) continue;
    const code = readFileSync(file, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      // Only a `//` that does NOT follow a colon or a quote starts a comment.
      .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
      .join('\n');
    if (/['"`][^'"`]*\/api\/embed/.test(code)) offenders.push(`${file} (ollama embed endpoint)`);
    if (/['"`]text-embedding[^'"`]*['"`]/.test(code)) offenders.push(`${file} (named embedding model)`);
  }
  assert.deepEqual(offenders, [],
    'these bypass the shared embedder — vectors from two models do not share a space');
});

await check('a stored vector remembers which model produced it', () => {
  // The safety net for a deliberate model change: without this, old and new
  // vectors sit side by side and nothing can tell them apart.
  const src = readFileSync('src/mastra/tools/dev/code-search-tools.ts', 'utf-8');
  assert.match(src, /embedding_model TEXT/, 'the column must exist');
  assert.match(src, /embedding_model === EMBEDDING_MODEL_ID/,
    'and a cached embedding may only be reused when its model still matches — '
    + 'otherwise a model change mixes spaces instead of re-embedding');
});

await check('LIVE: the index on disk holds exactly one model', async () => {
  // The corpus itself. If this ever fails, some vectors are stale and searches
  // are already degraded.
  //
  // `.mastra/repo-index.db` is not embedding-only: repo-indexer.ts writes its
  // own `files`/`symbols` tables into the SAME file (by design — see that
  // file's header comment), and it does so as a side effect of merely
  // importing `src/mastra/index.ts` (the startup repo-map scan), which
  // happens far more often than anyone running semantic code search. So the
  // file existing proves nothing about `code_chunks` existing — `existsSync`
  // alone let this check crash on a file that is real but simply hasn't had
  // an embedding run against it yet. Check the schema, not just the path.
  const { resolve } = await import('node:path');
  const { existsSync } = await import('node:fs');
  const dbPath = resolve('.mastra', 'repo-index.db');
  if (!existsSync(dbPath)) {
    console.log('    (no index built here — nothing to compare)');
    return;
  }
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath, { readonly: true });
  try {
    const hasCodeChunks = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'code_chunks'`,
    ).get();
    if (!hasCodeChunks) {
      console.log('    (repo-index.db exists but has no code_chunks table yet — no embeddings to compare)');
      return;
    }
    const models = db.prepare(
      'SELECT DISTINCT embedding_model AS m FROM code_chunks WHERE embedding IS NOT NULL',
    ).all() as Array<{ m: string | null }>;
    const distinct = models.map((r) => r.m).filter(Boolean);
    assert.ok(distinct.length <= 1,
      `the index holds vectors from ${distinct.length} models (${distinct.join(', ')}) — `
      + 'they do not share a space');
    if (distinct.length === 1) {
      assert.equal(distinct[0], EMBEDDING_MODEL_ID,
        'and the stored model must be the one configured now');
    }
  } finally {
    db.close();
  }
});

if (failures > 0) {
  console.error(`\n❌ check:embedding-consistency — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:embedding-consistency — one model, and every vector says which');
process.exit(0);
