#!/usr/bin/env tsx
/**
 * The FlavorDB resolver must be asked about INGREDIENTS, not about recipe lines.
 *
 * Live failure this pins: a probe of the palette that `chef_generate_menu` actually
 * sent to FlavorDB contained 'ziemniaków' (a genitive), 'szczypta zmielonej
 * kolendry' ("a pinch of ground coriander"), 'kiełbasy krakowskiej parzonej', an
 * entire either/or line, and 'kuchnia chińska' — a CUISINE. Six of fourteen entries
 * resolved (coverage 0.429); the pairwise audit could score 15 of 91 pairs. The
 * chemistry was never the problem: the questions were.
 *
 * Every case below is a VERBATIM string from the corpus (91 411 ingredient rows),
 * not an invented example. The asymmetry that shapes the rules: dropping a real
 * ingredient silently shrinks the audit, while letting junk through only adds an
 * unresolved entry the model is told about — so rejection stays conservative and
 * is driven by finite word lists rather than clever morphology.
 *
 * Run: npx tsx src/mastra/scripts/check-ingredient-normalizer.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  hasMojibake,
  isChapterBlob,
  lemmatizePolish,
  nonIngredientRatio,
  normalizeIngredientName,
  normalizeIngredientNames,
  repairMojibake,
} from '../tools/chef/ingredient-normalizer.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}: ${(error as Error).stack ?? (error as Error).message}`);
  }
}

/** First candidate, or null when the string is rejected as a non-ingredient. */
function best(raw: string): string | null {
  return normalizeIngredientName(raw).candidates[0] ?? null;
}

console.log('check:ingredient-normalizer');

// ── 1. The exact palette that shipped to FlavorDB in the live probe ──────────

check('LIVE REGRESSION: every junk entry from the probe palette is now stripped or dropped', () => {
  assert.equal(best('ziemniaków'), 'ziemniak', 'genitive → nominative');
  assert.equal(best('szczypta zmielonej kolendry'), 'kolendra', 'quantity + preparation stripped');
  assert.equal(best('gałązka zielonej pietruszki'), 'pietruszka', 'container + colour stripped');
  assert.equal(best('kiełbasy krakowskiej parzonej'), 'kiełbasa', 'origin + preparation stripped');
  assert.equal(best('kuchnia chińska'), null, 'a CUISINE is not an ingredient');
});

check('LIVE REGRESSION: an either/or line yields both options, the first one primary', () => {
  const r = normalizeIngredientName('średnie chińskie suszone czarne grzybki lub 3 duże obgotowane pieczarki');
  assert.equal(r.candidates[0], 'grzyb', 'the primary option');
  assert.deepEqual(r.alternatives, ['pieczarka'], 'the substitute, kept separately');
});

// ── 2. Quantities, units, containers, preparation ───────────────────────────

check('quantities and units are stripped, in both languages', () => {
  assert.equal(best('1/2 szklanki mleka'), 'mleko');
  assert.equal(best('ząbek czosnku'), 'czosnek');
  assert.equal(best('100g mąki'), 'mąka', 'a glued unit must not swallow the ingredient');
  assert.equal(best('2 cups all-purpose flour'), 'flour');
  assert.equal(best('t chili powder'), 'chili powder', "'t' is a teaspoon in this corpus");
});

check('trailing phrases and parentheticals are dropped', () => {
  assert.equal(best('pierś kurczaka ( bez skóry )'), 'pierś kurczak');
});

check('a list line yields SEPARATE ingredients, not a fallback chain', () => {
  // If pepper were a fallback for salt, the palette builder would resolve salt
  // and never look at it — the second ingredient would vanish silently.
  const r = normalizeIngredientName('sól i pieprz do smaku');
  assert.deepEqual(r.candidates, ['sól'], 'the first ingredient, with its own chain');
  assert.deepEqual(r.alternatives, ['pieprz'], 'the second stands on its own');
});

check('a nutrition-table row keeps its first column', () => {
  assert.equal(best('befsztyk wołowy\t100g\t114\t3,5'), 'befsztyk wołowy');
});

check('the most specific form comes first, the bare head noun second', () => {
  // The caller resolves down this chain and keeps the first form FlavorDB knows.
  assert.deepEqual(normalizeIngredientName('cebula dymka').candidates, ['cebula dymka', 'cebula']);
});

// ── 3. Non-ingredients ──────────────────────────────────────────────────────

check('metadata, labels, prose and bare numbers are rejected with a reason', () => {
  assert.equal(normalizeIngredientName('Yield: 4 servings').reason, 'metadata');
  assert.equal(normalizeIngredientName('copyright 2007 bustersrecipes.com').reason, 'metadata');
  assert.equal(normalizeIngredientName('x gn1/1').reason, 'metadata', 'a gastronorm pan code');
  assert.equal(normalizeIngredientName('1').reason, 'numeric');
  assert.equal(normalizeIngredientName('.').reason, 'numeric');
  assert.equal(normalizeIngredientName('rozgrzewamy piekarnik do 170 c.').reason, 'prose');
  assert.equal(best('TO:'), null, 'a section header');
});

check('CONSERVATIVE: ordinary ingredients are never mistaken for junk', () => {
  // Each of these shares a signal with something we reject — a colour word, an
  // origin word, a noun that also appears in a table header.
  for (const [raw, expected] of [
    ['biała fasola', 'fasola'],
    ['mięso', 'mięso'],
    ['czarny pieprz', 'pieprz'],
    ['sos sojowy', 'sos sojowy'],
    ['tempeh', 'tempeh'],
    ['bazylia', 'bazylia'],
  ] as Array<[string, string]>) {
    assert.equal(best(raw), expected, `${raw} must survive`);
  }
});

// ── 4. Mojibake ─────────────────────────────────────────────────────────────

check('CP1250-as-Latin-1 mojibake is repaired, preserving case', () => {
  assert.equal(repairMojibake('MIÊSO'), 'MIĘSO');
  assert.equal(repairMojibake('ksi¥¯ka kucharska'), 'książka kucharska');
  assert.equal(repairMojibake('Zrazy wo³owe'), 'Zrazy wołowe');
  assert.equal(best('MIÊSO'), 'mięso', 'and it flows through normalization');
});

check('a clean string is never "repaired" — the gate is diagnostic characters', () => {
  // 'ñ' and 'æ' are mojibake ONLY in a string that also carries an unambiguous
  // marker; on their own they are just Spanish and Danish.
  assert.equal(repairMojibake('jalapeño'), 'jalapeño');
  assert.equal(repairMojibake('æbleskiver'), 'æbleskiver');
  assert.equal(hasMojibake('jalapeño'), false);
  assert.equal(hasMojibake('MIÊSO'), true);
});

// ── 5. Lemmatization ────────────────────────────────────────────────────────

check('Polish declensions reduce toward the nominative', () => {
  assert.equal(lemmatizePolish('ziemniaków'), 'ziemniak');
  assert.equal(lemmatizePolish('pomidorów'), 'pomidor');
  assert.equal(lemmatizePolish('mąki'), 'mąka');
  assert.equal(lemmatizePolish('soli'), 'sól');
});

check('English words are left alone — the corpus is bilingual', () => {
  for (const w of ['honey', 'parsley', 'flour', 'butter', 'celery']) {
    assert.equal(lemmatizePolish(w), w, `${w} must not be mangled`);
  }
});

// ── 6. Chapter blobs ────────────────────────────────────────────────────────

const CHAPTER_ROWS = [
  'danie', 'wielkość', 'piec', 'kuchnia chińska', 'Zrazy wołowe', 'czewabcziczi',
  'rulonik', 'ryby i owoce morza', 'kuchnia węgierska', 'sposób przygotowania',
];
const REAL_RECIPE_ROWS = [
  '1 kg wołowiny', '2 cebule', '3 ząbki czosnku', 'sól', 'pieprz', 'olej',
  '200 ml śmietany', 'papryka', 'pomidory', 'bulion',
];

check('a chapter imported as one recipe is quarantined', () => {
  const blob = Array.from({ length: 60 }, (_, i) => CHAPTER_ROWS[i % CHAPTER_ROWS.length]);
  assert.equal(isChapterBlob('MIĘSO', blob), true);
  assert.ok(nonIngredientRatio(blob) > 0.5, 'its rows are mostly not ingredients');
});

check('ALL THREE signals are required — each alone would destroy real recipes', () => {
  const manyRows = Array.from({ length: 60 }, (_, i) => REAL_RECIPE_ROWS[i % REAL_RECIPE_ROWS.length]);
  const junkRows = Array.from({ length: 60 }, (_, i) => CHAPTER_ROWS[i % CHAPTER_ROWS.length]);

  // size only — '"Capitol Punishment" Chili' genuinely lists 101 ingredients
  assert.equal(isChapterBlob('"Capitol Punishment" Chili', manyRows), false);
  // junk rows only — OCR fragmented 'Another Chili Recipe' into bare 't'/number rows
  assert.equal(isChapterBlob('Another Chili Recipe', junkRows), false);
  // all-caps name only — a real potato-pancake recipe in this corpus
  assert.equal(isChapterBlob('WIEJSKIE PLACKI ZIEMNIACZANE', ['ziemniaki', 'mąka', 'jajo']), false);
});

check('a normal recipe scores far below the chapter-blob ratio', () => {
  assert.ok(
    nonIngredientRatio(REAL_RECIPE_ROWS) < 0.3,
    `measured mean for real recipes is 0.163, got ${nonIngredientRatio(REAL_RECIPE_ROWS)}`,
  );
});

// ── 7. Determinism and list behaviour ───────────────────────────────────────

check('PURE: the same input always yields the same output', () => {
  const raw = 'szczypta zmielonej kolendry';
  const once = JSON.stringify(normalizeIngredientName(raw));
  for (let i = 0; i < 5; i++) assert.equal(JSON.stringify(normalizeIngredientName(raw)), once);
});

check('a list is deduplicated by base form, keeping first-seen order', () => {
  const out = normalizeIngredientNames(['soli', 'sól', '2 łyżki soli', 'ziemniaków', 'kuchnia chińska']);
  assert.deepEqual(out.map((o) => o.candidates[0]), ['sól', 'ziemniak']);
});

check('degenerate input never throws', () => {
  for (const raw of ['', '   ', '\t\t', '((((', '???', ' ', 'a']) {
    assert.doesNotThrow(() => normalizeIngredientName(raw));
  }
});

// ── 8. Wiring — a normalizer nothing calls fixes nothing ─────────────────────

check('WIRED: chef_generate_menu builds its palette through the normalizer', () => {
  const tools = readFileSync('src/mastra/tools/chef/chef-tools.ts', 'utf8');
  assert.match(tools, /buildFlavorPalette\(repertoireIngredients, 14\)/, 'the audit must use the palette builder');
  assert.ok(
    !/new Set\(repertoireIngredients\.map/.test(tools),
    'the raw lowercase/dedupe palette must be gone',
  );
});

check('WIRED: retrieval drops chapter blobs, and the enrichment normalizes too', () => {
  const service = readFileSync('src/mastra/tools/chef/recipe-library-service.ts', 'utf8');
  assert.match(service, /isChapterBlob\(n, ingredientNames\)/, 'the junk filter must use the shared predicate');
  const enrich = readFileSync('src/mastra/scripts/enrich-recipe-flavor.ts', 'utf8');
  assert.match(enrich, /buildFlavorPalette/, 'per-recipe profiles must use the same normalization');
  assert.match(enrich, /SCHEMA_VERSION = 'fdb-v2'/, 'and must invalidate the profiles computed from raw names');
});

check('WIRED: the resolver memoizes, so the pairwise pass stays cheap', () => {
  // 14 items = 91 pairs = 182 resolve calls; without a memo every unresolved name
  // is re-embedded once per pair it appears in.
  const flavor = readFileSync('src/mastra/tools/chef/flavor-service.ts', 'utf8');
  assert.match(flavor, /resolveMemo/, 'resolveIngredient must memoize per index');
  assert.match(
    flavor,
    /skipAliasCache \? undefined : idx\.resolveMemo\.get\(key\)/,
    'and the alias BUILDER must bypass the memo',
  );
});

if (failures > 0) {
  console.error(`\n❌ check:ingredient-normalizer — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✅ check:ingredient-normalizer — FlavorDB is asked about ingredients, not about recipe lines');
process.exit(0);
