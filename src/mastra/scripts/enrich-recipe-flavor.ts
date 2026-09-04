/**
 * Recipe-library flavor enrichment (Phase 4).
 *
 * For each chef_recipe_library doc, resolve its ingredients against FlavorDB and store an
 * aggregate `flavorProfileFdb` on the doc:
 *   { descriptors[], dominant[], compoundCount, coverage, resolved, total, schemaVersion }
 *
 * Stored under a SEPARATE field (`flavorProfileFdb`), NOT the ingestion `flavorProfile`,
 * so it never collides with the embedding pipeline (embed-recipe-library reads
 * flavorProfile.dominant) — keeping FlavorDB reference chemistry cleanly separated.
 *
 * IDEMPOTENT: a `flavorProfileFdbHash` (ingredient names + schema version) gates re-work;
 * unchanged docs are skipped. Pass `--force` to re-enrich all (e.g. after rebuilding the
 * alias cache). Append-only — never deletes.
 *
 * Unlocks menu-level pairing (course-to-course aroma rotation, "max 2 dishes same family").
 * Run after load:flavordb + build:flavor-aliases.  Run: npm run enrich:recipe-flavor
 */
import { createHash } from 'node:crypto';

import { closeDb, getDb } from '../lib/mongo.js';
import {
  buildFlavorPalette,
  profileForIngredients,
  invalidateFlavorIndex,
} from '../tools/chef/flavor-service.js';

const COLLECTION = 'chef_recipe_library';
// Bump to invalidate all cached profiles (e.g. after a scoring/aggregation change).
// fdb-v2: names are normalized before the lookup (quantities/units/preparation
// stripped, non-ingredients dropped) instead of being sent as raw recipe lines.
const SCHEMA_VERSION = 'fdb-v2';
/** Generous per-recipe cap — real recipes sit well under it (p99 = 40 ingredients). */
const MAX_PROFILE_INGREDIENTS = 60;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface IngredientLike {
  name?: unknown;
}

function ingredientNames(doc: { ingredients?: unknown }): string[] {
  const ings = Array.isArray(doc.ingredients) ? (doc.ingredients as IngredientLike[]) : [];
  return ings
    .map((i) => (typeof i?.name === 'string' ? i.name.trim() : ''))
    .filter((n): n is string => n.length > 0);
}

async function main() {
  const force = process.argv.includes('--force');
  console.log(`[enrich-recipe-flavor] schema=${SCHEMA_VERSION} force=${force}`);
  invalidateFlavorIndex();

  const db = await getDb();
  const col = db.collection(COLLECTION);

  const docs = await col
    .find({}, { projection: { id: 1, name: 1, ingredients: 1, flavorProfileFdbHash: 1 } })
    .toArray();
  console.log(`[enrich-recipe-flavor] ${docs.length} recipes`);

  let enriched = 0;
  let skipped = 0;
  let empty = 0;

  for (const doc of docs) {
    const id = String((doc as { id?: unknown }).id ?? '');
    if (!id) continue;
    const names = ingredientNames(doc as { ingredients?: unknown });
    if (names.length === 0) {
      empty++;
      continue;
    }

    const hash = sha256(JSON.stringify([SCHEMA_VERSION, [...names].sort()]));
    if (!force && (doc as { flavorProfileFdbHash?: string }).flavorProfileFdbHash === hash) {
      skipped++;
      continue;
    }

    // Same normalization the menu-level audit uses — a raw line like
    // 'szczypta zmielonej kolendry' is not a FlavorDB question.
    const palette = await buildFlavorPalette(names, MAX_PROFILE_INGREDIENTS);
    if (palette.length === 0) {
      empty++;
      continue;
    }
    const profile = await profileForIngredients(palette.map((p) => p.name));
    const flavorProfileFdb = {
      descriptors: profile.dominantDescriptors.map((d) => d.descriptor),
      dominant: profile.dominantDescriptors.slice(0, 4).map((d) => d.descriptor),
      compoundCount: profile.compoundCount,
      coverage: profile.coverage,
      resolved: profile.resolved,
      total: profile.total,
      balanceFlags: profile.balanceFlags,
      schemaVersion: SCHEMA_VERSION,
    };

    await col.updateOne(
      { id },
      { $set: { flavorProfileFdb, flavorProfileFdbHash: hash, flavorProfileFdbAt: new Date() } },
    );
    enriched++;
    if (enriched % 250 === 0) {
      console.log(`[enrich-recipe-flavor] enriched ${enriched} (skipped ${skipped})…`);
    }
  }

  console.log(
    `[enrich-recipe-flavor] done: enriched=${enriched} skipped=${skipped} empty=${empty} | total=${docs.length}`,
  );
}

main()
  .catch((err) => {
    console.error('[enrich-recipe-flavor] fatal:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
