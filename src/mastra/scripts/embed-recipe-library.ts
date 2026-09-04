/**
 * Offline, one-time + incremental embedding of the chef's personal recipe library.
 *
 * Source of truth on disk: storage/recipes/recipes-structured/<category>.json
 *   (one array of structured recipe objects per category; `_*` helper files and
 *    empty arrays are skipped).
 *
 * What this script does:
 *  1. Reads every category JSON, skipping `_*` files and empty arrays.
 *  2. Per recipe builds a deterministic, high-signal `embeddingText` (see template)
 *     and `embeddingTextHash = sha256(text)`.
 *  3. Upserts into the `chef_recipe_library` Mongo collection.
 *  4. IDEMPOTENT: if the stored hash matches and an embedding already exists for the
 *     current EMBEDDING_MODEL_ID, the recipe is skipped (no embedder call). Only
 *     new/changed recipes are embedded. The existing corpus is reused forever.
 *  5. Computes `qualityScore` (confidence × field completeness) and `lang`.
 *  6. Flags recipes listed in config/locked-recipes.json as `usage:"locked"`.
 *
 * Embeddings PERSIST in Mongo and are NOT recomputed at Mastra startup — the
 * runtime service only READS them into an in-memory index. Re-run this script
 * after adding new recipes (append-only) to embed just the new ones.
 *
 * Run: npm run embed:recipe-library
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { closeDb, getDb } from '../lib/mongo.js';
import { EMBEDDING_MODEL_ID, generateEmbedding } from '../lib/embedder.js';

const COLLECTION = 'chef_recipe_library';
const RECIPES_DIR = resolve(process.cwd(), 'storage/recipes/recipes-structured');
const LOCKED_LIST_PATH = resolve(process.cwd(), 'src/mastra/config/locked-recipes.json');

// ── Recipe shape (subset we rely on; the rest is carried through verbatim) ──
interface RecipeIngredient {
  name?: string | null;
  quantity?: number | null;
  unit?: string | null;
  notes?: string | null;
}

interface Recipe {
  id: string;
  name?: string | null;
  aliases?: string[] | null;
  type?: string | null;
  category?: string | null;
  subcategory?: string | null;
  cuisine?: string[] | null;
  techniques?: string[] | null;
  flavorProfile?: { dominant?: string[] | null; family?: string | null } | null;
  textures?: string[] | null;
  temperature?: string | null;
  allergens?: string[] | null;
  dietaryTags?: string[] | null;
  ingredients?: RecipeIngredient[] | null;
  summary?: string | null;
  searchKeywords?: string[] | null;
  pairings?: string[] | null;
  usage?: string | null;
  provenance?: { extractionConfidence?: string | null } | null;
  [key: string]: unknown;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function uniq(items: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const v = (raw ?? '').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function firstSentence(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  const m = t.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : t).trim();
}

/**
 * Deterministic, high-signal embedding document built from RELIABLE structured
 * fields (name/ingredients/category/techniques) — robust even when `summary` is
 * the weak mechanical concatenation produced by the ingestion pass.
 */
function buildEmbeddingText(r: Recipe): string {
  const ingredientNames = uniq((r.ingredients ?? []).map((i) => i?.name ?? ''));
  const profile = uniq([
    ...(r.flavorProfile?.dominant ?? []),
    ...(r.textures ?? []),
    r.temperature,
  ]);
  const lines = [
    `[KATEGORIA] ${[r.category, r.subcategory].filter(Boolean).join('/')}`,
    `[NAZWA] ${[r.name, ...(r.aliases ?? [])].filter(Boolean).join(' ')}`,
    `[KUCHNIA] ${(r.cuisine ?? []).join(', ')}  [TYP] ${r.type ?? ''}`,
    `[TECHNIKI] ${(r.techniques ?? []).join(', ')}`,
    `[SKŁADNIKI] ${ingredientNames.join(', ')}`,
    `[PROFIL] ${profile.join(', ')}`,
    `[PAIRING] ${(r.pairings ?? []).join(', ')}`,
    `[OPIS] ${firstSentence(r.summary)}`,
  ];
  return lines.join('\n');
}

/** confidence (high=1.0/med=0.7/low=0.4) × field-completeness bonus (0.85–1.0). */
function computeQualityScore(r: Recipe): number {
  const conf = (r.provenance?.extractionConfidence ?? 'medium').toLowerCase();
  const base = conf === 'high' ? 1.0 : conf === 'low' ? 0.4 : 0.7;
  let filled = 0;
  const checks = [
    (r.ingredients ?? []).length > 0,
    (r.techniques ?? []).length > 0,
    Boolean(r.summary && r.summary.trim()),
    (r.flavorProfile?.dominant ?? []).length > 0,
    (r.pairings ?? []).length > 0,
  ];
  for (const ok of checks) if (ok) filled++;
  const completeness = 0.85 + 0.15 * (filled / checks.length); // 0.85..1.0
  return Math.round(base * completeness * 1000) / 1000;
}

/** Cheap diacritics/stopword heuristic — no external deps. */
function detectLang(r: Recipe): 'pl' | 'en' | 'mixed' {
  const text = [
    r.name,
    r.summary,
    ...(r.searchKeywords ?? []),
    ...(r.ingredients ?? []).map((i) => i?.name ?? ''),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!text) return 'mixed';
  const plDiacritics = (text.match(/[ąćęłńóśźż]/g) ?? []).length;
  const plStop = (text.match(/\b(i|z|do|na|w|oraz|dla|ze|przy|łyżka|szklanka|łyżeczka)\b/g) ?? [])
    .length;
  const enStop = (text.match(/\b(the|and|with|for|cup|tablespoon|teaspoon|of|to|in)\b/g) ?? [])
    .length;
  const pl = plDiacritics + plStop;
  if (pl > 0 && enStop > 0 && Math.min(pl, enStop) / Math.max(pl, enStop) > 0.5) return 'mixed';
  return pl >= enStop ? 'pl' : 'en';
}

function loadLockedIds(): Set<string> {
  if (!existsSync(LOCKED_LIST_PATH)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(LOCKED_LIST_PATH, 'utf8')) as unknown;
    const ids = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { ids?: unknown }).ids)
        ? (parsed as { ids: unknown[] }).ids
        : [];
    return new Set(ids.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function loadRecipes(): Recipe[] {
  const files = readdirSync(RECIPES_DIR).filter(
    (f) => f.endsWith('.json') && !f.startsWith('_'),
  );
  const all: Recipe[] = [];
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(RECIPES_DIR, file), 'utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    for (const r of parsed as Recipe[]) {
      if (r && typeof r.id === 'string') all.push(r);
    }
  }
  return all;
}

interface StoredDoc {
  embeddingTextHash?: string;
  embeddingModelId?: string;
  embedding?: number[];
}

async function main() {
  console.log(`[embed-recipe-library] model=${EMBEDDING_MODEL_ID} dir=${RECIPES_DIR}`);
  const lockedIds = loadLockedIds();
  console.log(`[embed-recipe-library] locked allowlist: ${lockedIds.size} id(s)`);

  const recipes = loadRecipes();
  console.log(`[embed-recipe-library] loaded ${recipes.length} active recipes from disk`);

  const db = await getDb();
  const col = db.collection<Recipe & StoredDoc>(COLLECTION);

  // Pull existing hashes once so idempotency check is a single round-trip.
  const existing = new Map<string, StoredDoc>();
  for (const doc of await col
    .find({}, { projection: { id: 1, embeddingTextHash: 1, embeddingModelId: 1, embedding: 1 } })
    .toArray()) {
    existing.set((doc as Recipe).id, doc as StoredDoc);
  }

  let embedded = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of recipes) {
    const embeddingText = buildEmbeddingText(r);
    const embeddingTextHash = sha256(embeddingText);
    const prev = existing.get(r.id);

    const unchanged =
      prev &&
      prev.embeddingTextHash === embeddingTextHash &&
      prev.embeddingModelId === EMBEDDING_MODEL_ID &&
      Array.isArray(prev.embedding) &&
      prev.embedding.length > 0;

    const usage = lockedIds.has(r.id) ? 'locked' : r.usage ?? 'adapt';

    if (unchanged) {
      // Still refresh cheap derived fields in case the allowlist changed,
      // but never re-embed.
      await col.updateOne({ id: r.id }, { $set: { usage } });
      skipped++;
      continue;
    }

    try {
      const embedding = await generateEmbedding(embeddingText);
      const doc: Recipe & StoredDoc & Record<string, unknown> = {
        ...r,
        usage,
        embedding,
        embeddingModelId: EMBEDDING_MODEL_ID,
        embeddingText,
        embeddingTextHash,
        lang: detectLang(r),
        qualityScore: computeQualityScore(r),
        updatedAt: new Date(),
      };
      await col.updateOne({ id: r.id }, { $set: doc }, { upsert: true });
      embedded++;
      if (embedded % 250 === 0) {
        console.log(`[embed-recipe-library] embedded ${embedded} (skipped ${skipped})…`);
      }
    } catch (err) {
      failed++;
      console.error(`[embed-recipe-library] FAILED id=${r.id}: ${(err as Error).message}`);
    }
  }

  const total = await col.countDocuments({});
  const withEmbedding = await col.countDocuments({ embedding: { $exists: true, $ne: [] } });
  console.log(
    `[embed-recipe-library] done: embedded=${embedded} skipped=${skipped} failed=${failed} | ` +
      `collection total=${total} withEmbedding=${withEmbedding}`,
  );
  if (total !== recipes.length) {
    console.warn(
      `[embed-recipe-library] NOTE: collection total (${total}) != active recipes on disk (${recipes.length}). ` +
        `This is expected only if disk recipes were removed (append-only policy says they should not be).`,
    );
  }
}

main()
  .catch((err) => {
    console.error('[embed-recipe-library] fatal:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
