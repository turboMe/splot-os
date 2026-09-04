/**
 * Quality gate for the FlavorDB pairing scorer (Phase 6).
 *
 * Reads scripts/fixtures/flavor-gold-pairings.json and checks:
 *   1. RANKING: every `good` (Western complementary) pair should show higher shared-compound
 *      overlap than every `anti` pair. Reported as pairwise agreement %.
 *   2. CUISINE FLIP: `crossCuisine` pairs scored under a Western vs an East-Asian cuisine —
 *      the SAME overlap should read as a better verdict under the contrasting (Eastern) axis
 *      than under the complementary (Western) axis when overlap is low.
 *   3. COVERAGE: % of fixture pairs where BOTH ingredients resolve, plus the top-200 chef
 *      ingredient coverage from chef_flavor_aliases.
 *
 * Acceptance (per ideas/molecules_pairing.md): good > anti in ≥ 85% of comparisons AND
 * top-200 ingredient coverage ≥ 70%.
 *
 * Run: npm run eval:flavor-pairing   (requires load:flavordb + build:flavor-aliases)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { closeDb, getDb } from '../lib/mongo.js';
import { scorePairing, type Verdict } from '../tools/chef/flavor-service.js';

const FIXTURE = resolve(process.cwd(), 'src/mastra/scripts/fixtures/flavor-gold-pairings.json');
const TARGET_RANKING = 0.85;
const TARGET_TOP_COVERAGE = 0.7;
const TOP_N = 200;

interface Pair {
  a: string;
  b: string;
  cuisine?: string;
}
interface CrossPair {
  a: string;
  b: string;
  western: string;
  eastern: string;
}
interface Fixture {
  good: Pair[];
  anti: Pair[];
  crossCuisine: CrossPair[];
}

const verdictRank: Record<Verdict, number> = { strong: 3, moderate: 2, weak: 1, unknown: 0 };

async function topIngredientCoverage(): Promise<{ matched: number; total: number; coverage: number }> {
  const db = await getDb();
  const top = await db
    .collection('chef_flavor_aliases')
    .find({}, { projection: { entityId: 1, freq: 1 } })
    .sort({ freq: -1 })
    .limit(TOP_N)
    .toArray();
  const matched = top.filter((r) => typeof r.entityId === 'number').length;
  const total = top.length || 1;
  return { matched, total, coverage: matched / total };
}

async function main() {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

  // ── 1. score good + anti ──
  const good = await Promise.all(
    fixture.good.map(async (p) => ({ p, s: await scorePairing(p.a, p.b, { cuisine: p.cuisine }) })),
  );
  const anti = await Promise.all(
    fixture.anti.map(async (p) => ({ p, s: await scorePairing(p.a, p.b, { cuisine: p.cuisine }) })),
  );

  const goodResolved = good.filter((g) => g.s.matched);
  const antiResolved = anti.filter((a) => a.s.matched);

  console.log('── GOOD pairs (Western complementary) ──');
  for (const g of good) {
    console.log(
      `  ${g.p.a} + ${g.p.b} → ${g.s.matched ? `shared=${g.s.shared} jaccard=${g.s.jaccard.toFixed(3)} verdict=${g.s.verdict}` : 'UNRESOLVED'}`,
    );
  }
  console.log('\n── ANTI pairs ──');
  for (const a of anti) {
    console.log(
      `  ${a.p.a} + ${a.p.b} → ${a.s.matched ? `shared=${a.s.shared} jaccard=${a.s.jaccard.toFixed(3)} verdict=${a.s.verdict}` : 'UNRESOLVED'}`,
    );
  }

  // ── ranking agreement: each good vs each anti on shared-compound count ──
  let comparisons = 0;
  let agree = 0;
  for (const g of goodResolved) {
    for (const a of antiResolved) {
      comparisons++;
      if (g.s.shared > a.s.shared) agree++;
      else if (g.s.shared === a.s.shared && g.s.jaccard > a.s.jaccard) agree++;
    }
  }
  const ranking = comparisons > 0 ? agree / comparisons : 0;

  // ── 2. cuisine flip ──
  console.log('\n── CUISINE FLIP (low overlap → better under contrasting axis) ──');
  let flipChecked = 0;
  let flipCorrect = 0;
  for (const c of fixture.crossCuisine) {
    const [west, east] = await Promise.all([
      scorePairing(c.a, c.b, { cuisine: c.western }),
      scorePairing(c.a, c.b, { cuisine: c.eastern }),
    ]);
    if (!west.matched || !east.matched) {
      console.log(`  ${c.a} + ${c.b} → UNRESOLVED (skipped)`);
      continue;
    }
    flipChecked++;
    const correct = verdictRank[east.verdict] >= verdictRank[west.verdict];
    if (correct) flipCorrect++;
    console.log(
      `  ${c.a} + ${c.b} (shared=${west.shared}) → west(${c.western})=${west.verdict} | east(${c.eastern})=${east.verdict} ${correct ? '✓' : '✗'}`,
    );
  }

  // ── 3. coverage ──
  const totalPairs = good.length + anti.length;
  const resolvedPairs = goodResolved.length + antiResolved.length;
  const pairCoverage = totalPairs > 0 ? resolvedPairs / totalPairs : 0;
  const topCov = await topIngredientCoverage();

  console.log('\n──────────────── SUMMARY ────────────────');
  console.log(`ranking agreement (good>anti): ${(ranking * 100).toFixed(1)}% (${agree}/${comparisons})  target ≥ ${(TARGET_RANKING * 100).toFixed(0)}%`);
  console.log(`cuisine-flip correctness     : ${flipChecked > 0 ? ((flipCorrect / flipChecked) * 100).toFixed(1) : 'n/a'}% (${flipCorrect}/${flipChecked})`);
  console.log(`fixture pair coverage        : ${(pairCoverage * 100).toFixed(1)}% (${resolvedPairs}/${totalPairs})`);
  console.log(`top-${topCov.total} ingredient coverage : ${(topCov.coverage * 100).toFixed(1)}% (${topCov.matched}/${topCov.total})  target ≥ ${(TARGET_TOP_COVERAGE * 100).toFixed(0)}%`);

  const rankingPass = ranking >= TARGET_RANKING;
  const coveragePass = topCov.coverage >= TARGET_TOP_COVERAGE;
  console.log('\n──────────────── GATE ────────────────');
  console.log(`ranking : ${rankingPass ? 'PASS' : 'FAIL'}`);
  console.log(`coverage: ${coveragePass ? 'PASS' : 'FAIL'}`);
  if (!rankingPass || !coveragePass) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[eval-flavor-pairing] fatal:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
