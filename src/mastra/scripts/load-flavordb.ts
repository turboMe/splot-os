/**
 * Offline, idempotent loader for the vendored FlavorDB data (Phase 1).
 *
 * Source of truth on disk: storage/flavordb/{flavordb.csv,molecules.csv}
 *   (pinned scrape of FlavorDB / cosylab IIIT-Delhi — see storage/flavordb/SOURCE.md).
 *
 * What this script does:
 *  1. Parses both CSVs with an RFC4180-aware line parser (cells with commas are quoted)
 *     and a tolerant set-literal tokenizer for the messy `{...}` Python-set cells.
 *  2. Builds two Mongo collections (reference chemistry — kept SEPARATE from the chef's
 *     own repertoire in chef_recipe_library):
 *       - chef_flavor_molecules:   { pubchemId, commonName, descriptors[] }
 *       - chef_flavor_ingredients: { entityId, name, synonyms[], scientificName, category,
 *                                    moleculeIds[], descriptors[] (union over its molecules),
 *                                    nameEmbedding[] (bge-m3 of `name + synonyms`, for Phase 2) }
 *  3. IDEMPOTENT: each ingredient carries a contentHash; nameEmbedding is only recomputed
 *     when `name + synonyms` changes (or the embedding model changes). Embeddings persist
 *     in Mongo and are NEVER recomputed at runtime — flavor-service.ts only READS them.
 *  4. Parse-sanity guard: asserts row counts fall in the expected band (≈935 / ≈1791).
 *
 * Run: npm run load:flavordb
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { closeDb, getDb } from '../lib/mongo.js';
import { EMBEDDING_MODEL_ID, generateEmbedding } from '../lib/embedder.js';

const MOLECULES_COLLECTION = 'chef_flavor_molecules';
const INGREDIENTS_COLLECTION = 'chef_flavor_ingredients';
const FLAVORDB_DIR = resolve(process.cwd(), 'storage/flavordb');
const INGREDIENTS_CSV = resolve(FLAVORDB_DIR, 'flavordb.csv');
const MOLECULES_CSV = resolve(FLAVORDB_DIR, 'molecules.csv');

// Parse-sanity bands (vendored 2026-06-15: 935 ingredients / 1791 molecules).
const MIN_INGREDIENTS = 800;
const MIN_MOLECULES = 1500;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * RFC4180-aware single-line CSV parser. Handles double-quoted fields containing
 * commas (e.g. the `"{27457, 7976}"` set cells) and escaped `""` quotes. The
 * source files keep every record on one physical line, so per-line parsing is safe.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** Split a file into non-empty logical lines (tolerant of CRLF and a trailing newline). */
function splitLines(raw: string): string[] {
  return raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.length > 0);
}

/** Extract integer PubChem IDs from a Python-set literal like `"{27457, 7976}"`. */
function parseIntSet(cell: string): number[] {
  const matches = cell.match(/\d+/g);
  if (!matches) return [];
  const seen = new Set<number>();
  for (const m of matches) {
    const n = Number(m);
    if (Number.isFinite(n)) seen.add(n);
  }
  return [...seen];
}

/** Extract quoted descriptor/synonym strings from a set literal like `{'sweet', 'fruity'}`. */
function parseStringSet(cell: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Match single- or double-quoted tokens inside the set literal.
  const re = /'([^']*)'|"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cell)) !== null) {
    const v = (m[1] ?? m[2] ?? '').trim().toLowerCase();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

interface MoleculeRow {
  pubchemId: number;
  commonName: string;
  descriptors: string[];
}

interface IngredientRow {
  entityId: number;
  name: string;
  synonyms: string[];
  scientificName: string;
  category: string;
  moleculeIds: number[];
}

function loadMolecules(): MoleculeRow[] {
  if (!existsSync(MOLECULES_CSV)) {
    throw new Error(`Missing ${MOLECULES_CSV} — vendor it first (see storage/flavordb/SOURCE.md).`);
  }
  const lines = splitLines(readFileSync(MOLECULES_CSV, 'utf8'));
  // header: ,Unnamed: 0,pubchem id,common name,flavor profile
  const rows: MoleculeRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 5) continue;
    const pubchemId = Number(cols[2]);
    if (!Number.isFinite(pubchemId)) continue;
    rows.push({
      pubchemId,
      commonName: cols[3].trim(),
      descriptors: parseStringSet(cols[4]),
    });
  }
  return rows;
}

function loadIngredients(): IngredientRow[] {
  if (!existsSync(INGREDIENTS_CSV)) {
    throw new Error(`Missing ${INGREDIENTS_CSV} — vendor it first (see storage/flavordb/SOURCE.md).`);
  }
  const lines = splitLines(readFileSync(INGREDIENTS_CSV, 'utf8'));
  // header: ,entity id,alias,synonyms,scientific name,category,molecules
  const rows: IngredientRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 7) continue;
    const entityId = Number(cols[1]);
    if (!Number.isFinite(entityId)) continue;
    const name = cols[2].trim().toLowerCase();
    if (!name) continue;
    // synonyms cell may duplicate the alias — keep distinct, drop the alias itself.
    const synonyms = parseStringSet(cols[3]).filter((s) => s !== name);
    rows.push({
      entityId,
      name,
      synonyms,
      scientificName: cols[4].trim().toLowerCase(),
      category: cols[5].trim().toLowerCase(),
      moleculeIds: parseIntSet(cols[6]),
    });
  }
  return rows;
}

interface StoredIngredient {
  contentHash?: string;
  embeddingModelId?: string;
  nameEmbedding?: number[];
}

async function main() {
  console.log(`[load-flavordb] model=${EMBEDDING_MODEL_ID} dir=${FLAVORDB_DIR}`);

  const molecules = loadMolecules();
  const ingredients = loadIngredients();
  console.log(`[load-flavordb] parsed ${ingredients.length} ingredients, ${molecules.length} molecules`);

  if (ingredients.length < MIN_INGREDIENTS || molecules.length < MIN_MOLECULES) {
    throw new Error(
      `[load-flavordb] parse-sanity FAILED: ingredients=${ingredients.length} (≥${MIN_INGREDIENTS}), ` +
        `molecules=${molecules.length} (≥${MIN_MOLECULES}). Aborting — check CSV integrity.`,
    );
  }

  const db = await getDb();

  // ── Molecules: descriptor lookup (pubchemId → descriptors). Pure upsert. ──
  const molCol = db.collection(MOLECULES_COLLECTION);
  for (const m of molecules) {
    await molCol.updateOne(
      { pubchemId: m.pubchemId },
      { $set: { pubchemId: m.pubchemId, commonName: m.commonName, descriptors: m.descriptors } },
      { upsert: true },
    );
  }
  console.log(`[load-flavordb] molecules upserted: ${molecules.length}`);

  // Descriptor map for ingredient-level union.
  const descByPubchem = new Map<number, string[]>();
  for (const m of molecules) descByPubchem.set(m.pubchemId, m.descriptors);

  // ── Ingredients: profile + lazy nameEmbedding (recomputed only when text changes). ──
  const ingCol = db.collection<IngredientRow & StoredIngredient & Record<string, unknown>>(
    INGREDIENTS_COLLECTION,
  );
  const existing = new Map<number, StoredIngredient>();
  for (const doc of await ingCol
    .find({}, { projection: { entityId: 1, contentHash: 1, embeddingModelId: 1, nameEmbedding: 1 } })
    .toArray()) {
    existing.set((doc as unknown as IngredientRow).entityId, doc as StoredIngredient);
  }

  let embedded = 0;
  let skipped = 0;
  let failed = 0;

  for (const ing of ingredients) {
    // Descriptor union over the ingredient's molecules.
    const descSet = new Set<string>();
    for (const mid of ing.moleculeIds) {
      for (const d of descByPubchem.get(mid) ?? []) descSet.add(d);
    }
    const descriptors = [...descSet];

    const embeddingText = [ing.name, ...ing.synonyms].join(' ').trim();
    const contentHash = sha256(
      JSON.stringify({ embeddingText, scientificName: ing.scientificName, category: ing.category }),
    );
    const prev = existing.get(ing.entityId);
    const embeddingFresh =
      prev &&
      prev.contentHash === contentHash &&
      prev.embeddingModelId === EMBEDDING_MODEL_ID &&
      Array.isArray(prev.nameEmbedding) &&
      prev.nameEmbedding.length > 0;

    const base: Record<string, unknown> = {
      entityId: ing.entityId,
      name: ing.name,
      synonyms: ing.synonyms,
      scientificName: ing.scientificName,
      category: ing.category,
      moleculeIds: ing.moleculeIds,
      descriptors,
      contentHash,
      embeddingModelId: EMBEDDING_MODEL_ID,
      updatedAt: new Date(),
    };

    if (embeddingFresh) {
      // Refresh derived chemistry (descriptors may shift if molecules.csv changed) but
      // keep the existing embedding — no embedder call.
      await ingCol.updateOne({ entityId: ing.entityId }, { $set: base });
      skipped++;
      continue;
    }

    try {
      const nameEmbedding = await generateEmbedding(embeddingText);
      await ingCol.updateOne(
        { entityId: ing.entityId },
        { $set: { ...base, nameEmbedding } },
        { upsert: true },
      );
      embedded++;
      if (embedded % 100 === 0) {
        console.log(`[load-flavordb] embedded ${embedded} ingredient names (skipped ${skipped})…`);
      }
    } catch (err) {
      failed++;
      console.error(`[load-flavordb] FAILED entityId=${ing.entityId} (${ing.name}): ${(err as Error).message}`);
    }
  }

  const ingTotal = await ingCol.countDocuments({});
  const withEmbedding = await ingCol.countDocuments({ nameEmbedding: { $exists: true, $ne: [] } });
  const molTotal = await molCol.countDocuments({});
  console.log(
    `[load-flavordb] done: ingredients embedded=${embedded} skipped=${skipped} failed=${failed} | ` +
      `ingredients total=${ingTotal} withEmbedding=${withEmbedding} | molecules total=${molTotal}`,
  );
}

main()
  .catch((err) => {
    console.error('[load-flavordb] fatal:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
