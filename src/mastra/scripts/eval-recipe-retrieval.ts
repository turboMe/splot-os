/**
 * Quality gate for recipe-library retrieval.
 *
 * Reads scripts/fixtures/recipe-gold-queries.json (~30 queries, each with a set
 * of acceptable `expected` ids), runs recipe-library-service.search() for each,
 * and reports recall@5, recall@10 and MRR. A query is a hit at rank-k if ANY of
 * its expected ids appears in the top-k results.
 *
 * Acceptance target (per the implementation plan): recall@10 >= 0.85.
 * If the gate fails, that's the trigger to run the conditional Phase 6 enrichment.
 *
 * Run: npm run eval:recipe-retrieval   (requires embed:recipe-library to have run)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { closeDb } from '../lib/mongo.js';
import { search, type RecipeSearchOptions } from '../tools/chef/recipe-library-service.js';

const FIXTURE = resolve(
  process.cwd(),
  'src/mastra/scripts/fixtures/recipe-gold-queries.json',
);
const TARGET_RECALL_AT_10 = 0.85;
const TOP_K = 10;

interface GoldQuery {
  query: string;
  expected: string[];
  opts?: RecipeSearchOptions;
}

function firstHitRank(resultIds: string[], expected: Set<string>): number {
  for (let i = 0; i < resultIds.length; i++) {
    if (expected.has(resultIds[i])) return i + 1; // 1-based
  }
  return 0; // miss
}

async function main() {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { queries: GoldQuery[] };
  const queries = fixture.queries;
  console.log(`[eval-recipe-retrieval] ${queries.length} gold queries, top-k=${TOP_K}\n`);

  let hit5 = 0;
  let hit10 = 0;
  let mrrSum = 0;
  const rows: Array<{ q: string; rank: number; top: string }> = [];

  for (const g of queries) {
    const expected = new Set(g.expected);
    const results = await search(g.query, { ...(g.opts ?? {}), limit: TOP_K });
    const ids = results.map((r) => r.id);
    const rank = firstHitRank(ids, expected);

    if (rank > 0 && rank <= 5) hit5++;
    if (rank > 0 && rank <= 10) hit10++;
    if (rank > 0) mrrSum += 1 / rank;

    rows.push({
      q: g.query,
      rank,
      top: ids[0] ? `${ids[0]}${rank === 1 ? ' ✓' : ''}` : '(no results)',
    });
  }

  const n = queries.length;
  const recall5 = hit5 / n;
  const recall10 = hit10 / n;
  const mrr = mrrSum / n;

  console.log('rank  query / first result');
  console.log('────  ─────────────────────────────────────────────');
  for (const r of rows) {
    const mark = r.rank === 0 ? ' MISS' : `  @${r.rank}`;
    console.log(`${mark.padStart(5)}  ${r.q}`);
    console.log(`       → ${r.top}`);
  }

  console.log('\n──────────────── SUMMARY ────────────────');
  console.log(`recall@5  : ${(recall5 * 100).toFixed(1)}%  (${hit5}/${n})`);
  console.log(`recall@10 : ${(recall10 * 100).toFixed(1)}%  (${hit10}/${n})`);
  console.log(`MRR       : ${mrr.toFixed(3)}`);
  console.log('─────────────────────────────────────────');

  if (recall10 >= TARGET_RECALL_AT_10) {
    console.log(
      `✅ PASS — recall@10 ${(recall10 * 100).toFixed(1)}% >= target ${(TARGET_RECALL_AT_10 * 100).toFixed(0)}%. ` +
        `v1 (structured-field embedding) is sufficient; Phase 6 enrichment NOT required.`,
    );
  } else {
    console.log(
      `⚠️  BELOW TARGET — recall@10 ${(recall10 * 100).toFixed(1)}% < ${(TARGET_RECALL_AT_10 * 100).toFixed(0)}%. ` +
        `Tune the embeddingText template / RRF, or trigger Phase 6 (local-LLM enrichment).`,
    );
    process.exitCode = 2;
  }
}

main()
  .catch((err) => {
    console.error('[eval-recipe-retrieval] fatal:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
