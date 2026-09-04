/**
 * Cross-lingual ingredient resolver — chef ingredient name → FlavorDB entity (Phase 2).
 *
 * The chef's recipes are POLISH; FlavorDB is ENGLISH. This script builds and persists the
 * `chef_flavor_aliases` cache so the runtime never has to embed-match per query.
 *
 *  1. Extract the chef's ingredient vocabulary (distinct `ingredients.name` from
 *     chef_recipe_library + chef_recipes), normalized; count frequency.
 *  2. Resolve each via flavor-service (exact name/synonym → bge-m3 cosine ≥ MATCH_THRESHOLD).
 *  3. Apply manual overrides (src/mastra/config/flavor-aliases-overrides.json) last —
 *     they win over auto-matches and can force `unresolved`.
 *  4. Persist chef_flavor_aliases { chefName, entityId|null, method, score, freq, example }.
 *  5. Emit a coverage report (overall + frequency-weighted + top-200). GATE: top-200
 *     coverage ≥ 0.70, else prioritize overrides before wiring the scorer into the pipeline.
 *
 * Idempotent: re-running re-resolves everything and upserts. Run after load:flavordb.
 * Run: npm run build:flavor-aliases
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { closeDb, getDb } from '../lib/mongo.js';
import {
  resolveIngredient,
  normalizeName,
  invalidateFlavorIndex,
} from '../tools/chef/flavor-service.js';

const ALIASES_COLLECTION = 'chef_flavor_aliases';
const RECIPE_LIBRARY = 'chef_recipe_library';
const RECIPES = 'chef_recipes';
const OVERRIDES_PATH = resolve(process.cwd(), 'src/mastra/config/flavor-aliases-overrides.json');
const TOP_N_GATE = 200;
const TOP_N_TARGET = 0.7;

interface OverrideEntry {
  chefName: string;
  flavordbName?: string;
  entityId?: number;
  unresolved?: boolean;
}

function loadOverrides(): OverrideEntry[] {
  if (!existsSync(OVERRIDES_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8')) as { overrides?: OverrideEntry[] };
    return Array.isArray(parsed.overrides) ? parsed.overrides : [];
  } catch {
    return [];
  }
}

interface VocabEntry {
  norm: string;
  example: string;
  freq: number;
}

// Non-ingredient strings that leaked into `ingredients.name` from messy scraped recipes:
// cuisine tags, yield/serving metadata, copyright/URL lines, and short codes. They can never
// resolve to FlavorDB and they crowd out real ingredients in the top-200 coverage gate.
const JUNK_KEYWORDS = /\b(kuchnia|yield|servings?|copyright|recipe|recipes|www|http|przepis|ml|cup|cups|tbsp|tsp)\b/;
const JUNK_DOMAIN = /\b(com|net|org)\b/;

function isJunkIngredient(norm: string): boolean {
  if (JUNK_KEYWORDS.test(norm)) return true;
  if (JUNK_DOMAIN.test(norm)) return true;
  if (/\d/.test(norm) && norm.replace(/[^a-z]/g, '').length <= 3) return true; // codes like "x gn1 1"
  if (norm.split(' ').filter(Boolean).length > 5) return true; // run-on lines, not names
  return false;
}

async function extractVocabulary(): Promise<Map<string, VocabEntry>> {
  const db = await getDb();
  const vocab = new Map<string, VocabEntry>();

  const bump = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const example = raw.trim();
    const norm = normalizeName(example);
    if (!norm || norm.length < 2) return;
    if (isJunkIngredient(norm)) return;
    const prev = vocab.get(norm);
    if (prev) prev.freq += 1;
    else vocab.set(norm, { norm, example, freq: 1 });
  };

  for (const coll of [RECIPE_LIBRARY, RECIPES]) {
    const cursor = db
      .collection(coll)
      .find({}, { projection: { 'ingredients.name': 1 } });
    for await (const doc of cursor) {
      const raw = (doc as { ingredients?: unknown }).ingredients;
      const ings = Array.isArray(raw) ? (raw as Array<{ name?: unknown }>) : [];
      for (const ing of ings) bump(ing?.name);
    }
  }
  return vocab;
}

async function main() {
  const force = process.argv.includes('--force');
  console.log(`[build-flavor-aliases] extracting chef ingredient vocabulary… (force=${force})`);
  invalidateFlavorIndex(); // ensure fresh FlavorDB index (post-load)
  const vocab = await extractVocabulary();
  console.log(`[build-flavor-aliases] ${vocab.size} distinct ingredient names`);
  if (vocab.size === 0) {
    console.warn('[build-flavor-aliases] no chef ingredients found — run embed:recipe-library first?');
  }

  const overrides = loadOverrides();
  // Resolve override targets (flavordbName → entityId) up front.
  const overrideByNorm = new Map<string, { entityId: number | null; targetName?: string }>();
  for (const ov of overrides) {
    const key = normalizeName(ov.chefName);
    if (!key) continue;
    if (ov.unresolved) {
      overrideByNorm.set(key, { entityId: null });
      continue;
    }
    if (typeof ov.entityId === 'number') {
      overrideByNorm.set(key, { entityId: ov.entityId });
      continue;
    }
    if (ov.flavordbName) {
      const r = await resolveIngredient(ov.flavordbName, { skipAliasCache: true });
      overrideByNorm.set(key, {
        entityId: r.matched ? r.entityId : null,
        targetName: r.name,
      });
      if (!r.matched) {
        console.warn(`[build-flavor-aliases] override target not in FlavorDB: "${ov.flavordbName}" → unresolved`);
      }
    }
  }

  const db = await getDb();
  const col = db.collection(ALIASES_COLLECTION);

  // ── Incremental: reuse already-resolved aliases so re-runs (after adding new recipes)
  // only EMBED brand-new ingredient names. Pass --force to re-resolve everything. ──
  const existing = new Map<string, { entityId: number | null; method: string; score: number }>();
  if (!force) {
    for (const doc of await col
      .find({}, { projection: { chefName: 1, entityId: 1, method: 1, score: 1 } })
      .toArray()) {
      const key = normalizeName(String((doc as { chefName?: unknown }).chefName ?? ''));
      if (!key) continue;
      existing.set(key, {
        entityId: typeof doc.entityId === 'number' ? doc.entityId : null,
        method: String((doc as { method?: unknown }).method ?? 'cached'),
        score: typeof doc.score === 'number' ? doc.score : 0,
      });
    }
    console.log(`[build-flavor-aliases] ${existing.size} aliases already cached — embedding only new names`);
  }

  let matched = 0;
  let embedded = 0;
  let reused = 0;
  let freqTotal = 0;
  let freqMatched = 0;
  const rows: Array<{ norm: string; freq: number; entityId: number | null; method: string; score: number }> = [];

  for (const v of vocab.values()) {
    freqTotal += v.freq;
    let entityId: number | null;
    let method: string;
    let score: number;

    const ov = overrideByNorm.get(v.norm);
    const cached = existing.get(v.norm);
    if (ov) {
      entityId = ov.entityId;
      method = 'manual';
      score = ov.entityId !== null ? 1 : 0;
    } else if (cached && cached.method !== 'manual') {
      // Already resolved on a previous run — keep it, just refresh freq below. No embed.
      entityId = cached.entityId;
      method = cached.method;
      score = cached.score;
      reused += 1;
    } else {
      const r = await resolveIngredient(v.example, { skipAliasCache: true });
      entityId = r.matched ? r.entityId : null;
      method = r.method;
      score = r.score;
      embedded += 1;
    }

    if (entityId !== null) {
      matched += 1;
      freqMatched += v.freq;
    }

    await col.updateOne(
      { chefName: v.norm },
      {
        $set: {
          chefName: v.norm,
          example: v.example,
          entityId,
          method,
          score: Math.round(score * 1000) / 1000,
          freq: v.freq,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
    rows.push({ norm: v.norm, freq: v.freq, entityId, method, score });
  }

  console.log(`[build-flavor-aliases] resolved: embedded=${embedded} reused=${reused} (no re-embed)`);

  // ── Coverage report ──
  const total = vocab.size || 1;
  const overallCoverage = matched / total;
  const weightedCoverage = freqTotal > 0 ? freqMatched / freqTotal : 0;

  const top = [...rows].sort((a, b) => b.freq - a.freq).slice(0, TOP_N_GATE);
  const topMatched = top.filter((r) => r.entityId !== null).length;
  const topCoverage = top.length > 0 ? topMatched / top.length : 0;

  console.log('\n──────────────── COVERAGE ────────────────');
  console.log(`distinct ingredients : ${vocab.size}`);
  console.log(`matched              : ${matched} (${(overallCoverage * 100).toFixed(1)}%)`);
  console.log(`frequency-weighted   : ${(weightedCoverage * 100).toFixed(1)}%`);
  console.log(`top-${top.length} coverage     : ${topMatched}/${top.length} (${(topCoverage * 100).toFixed(1)}%)`);
  console.log('\ntop-20 unresolved by frequency (add overrides if high-value):');
  const unresolvedTop = [...rows]
    .filter((r) => r.entityId === null)
    .sort((a, b) => b.freq - a.freq)
    .slice(0, 20);
  for (const r of unresolvedTop) console.log(`  ${String(r.freq).padStart(4)}×  ${r.norm}`);

  console.log('\n──────────────── GATE ────────────────');
  if (topCoverage >= TOP_N_TARGET) {
    console.log(`PASS: top-${top.length} coverage ${(topCoverage * 100).toFixed(1)}% ≥ ${(TOP_N_TARGET * 100).toFixed(0)}%`);
  } else {
    console.log(
      `BELOW TARGET: top-${top.length} coverage ${(topCoverage * 100).toFixed(1)}% < ${(TOP_N_TARGET * 100).toFixed(0)}% — ` +
        `add overrides for the frequent misses above before relying on the scorer in the pipeline.`,
    );
  }
}

main()
  .catch((err) => {
    console.error('[build-flavor-aliases] fatal:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
