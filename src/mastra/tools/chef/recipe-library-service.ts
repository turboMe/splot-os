/**
 * Personal recipe-library retrieval service — hybrid, Mongo-Community compatible.
 *
 * The chef's own repertoire lives in `chef_recipe_library` (system-of-record).
 * Embeddings are PERSISTED there by scripts/embed-recipe-library.ts and are
 * NEVER recomputed at startup — this service only READS them into a lazy
 * module-level in-memory index (~8.7k × 1024 floats ≈ 35 MB) on first use.
 *
 * search() pipeline (per recipe-library-retrieval-design.md §3):
 *   1. Pre-filter (category/type + allergen exclusion) — narrows candidates.
 *   2. Vector leg   — embed query (bge-m3), cosine vs candidate embeddings.
 *   3. Lexical leg  — Mongo $text on the same candidate filter.
 *   4. Fuse         — Reciprocal Rank Fusion (RRF, k=60).
 *   5. Rerank       — × qualityScore, stage boost, dedup near-identical names.
 *   6. Return top-`limit` full recipe records.
 *
 * Mongo Community has no $vectorSearch, so the vector leg is app-side cosine —
 * the same pattern as chef-service.searchNotes, but built to scale to ~10k.
 */
import type { Db } from 'mongodb';

import { getDb } from './db.js';
import { isChapterBlob } from './ingredient-normalizer.js';
import { cosineSimilarity, generateEmbedding } from '../../lib/embedder.js';

const COLLECTION = 'chef_recipe_library';
const RRF_K = 60;
const VECTOR_LEG_N = 40;
const LEXICAL_LEG_N = 40;
const INDEX_TTL_MS = 10 * 60 * 1000; // lazy refresh ceiling; explicit invalidate on re-embed

/**
 * P0 relevance floor (max cosine vs query). Tuned from the live-run cosine probe:
 * genuine on-brief hits scored 0.51–0.61 (e.g. tatar→Steak Tartare = 0.510),
 * clear off-brief junk scored 0.46–0.55 (e.g. bisque→0.464). The bands OVERLAP,
 * so a single cosine cut can't separate cleanly. We set the floor at the bottom
 * of the GOOD band (0.50) to drop the clear-junk tail (≤0.49) WITHOUT discarding
 * real ~0.51 matches. The structural junk filter (below) + the orchestrator's own
 * judgement cover the ambiguous 0.50–0.55 overlap zone. Skipped entirely when the
 * embedder is unavailable (vector leg empty) so search degrades, not breaks.
 */
const RELEVANCE_FLOOR = 0.5;

/**
 * Structural junk predicate applied at index-load so junk never enters retrieval.
 * Catches the high-confidence bad-data classes found in the corpus (~746/8664):
 * empty ingredient lists, numbered-name fragments ("147.", "49. Brown Sugar…"),
 * colon-terminated headers ("TO:", "From Cobblers:"), and over-long run-on names.
 *
 * Plus CHAPTER BLOBS (see isChapterBlob): whole cookbook chapters imported as a
 * single recipe. The live probe query used to return 'MIÊSO' — 235 "ingredients",
 * one OCR'd meat chapter — as its second hit, and that record alone supplied most
 * of the junk that reached FlavorDB.
 */
const JUNK_NUMBERED = /^\s*\d+\s*[.)]/;
const JUNK_TRAILING_COLON = /:\s*$/;
const JUNK_NAME_MAX_LEN = 45;

function isJunkEntry(name: string, ingredientNames: string[]): boolean {
  if (ingredientNames.length === 0) return true;
  const n = name.trim();
  if (n.length === 0) return true;
  if (n.length > JUNK_NAME_MAX_LEN) return true;
  if (JUNK_NUMBERED.test(n)) return true;
  if (JUNK_TRAILING_COLON.test(n)) return true;
  if (isChapterBlob(n, ingredientNames)) return true;
  return false;
}

export interface RecipeSearchOptions {
  /** restrict to a category slug (e.g. 'sosy-cieple') */
  category?: string;
  /** 'component' (building blocks) | 'dish' (full plates) */
  type?: 'component' | 'dish';
  /** allergen names to exclude — recipes whose `allergens` intersect are dropped */
  dietaryExclude?: string[];
  /** soft stage hint: boost components ('recipe' stage) or dishes ('menu' stage) */
  stage?: 'menu' | 'recipe';
  limit?: number;
}

export interface RecipeSearchHit {
  id: string;
  name: string;
  category: string;
  type: string;
  usage: string;
  summary: string | null;
  ingredients: Array<{ name?: string | null; quantity?: number | null; unit?: string | null }>;
  techniques: string[];
  provenance: Record<string, unknown> | null;
  score: number;
}

// ── In-memory index (lightweight; full records fetched from Mongo at the end) ──
interface IndexEntry {
  id: string;
  embedding: number[];
  qualityScore: number;
  category: string;
  type: string;
  name: string;
  allergens: string[];
}

let indexCache: IndexEntry[] | null = null;
let indexLoadedAt = 0;
let indexLoading: Promise<IndexEntry[]> | null = null;

/** Drop the in-memory index so the next search reloads fresh vectors from Mongo. */
export function invalidateRecipeIndex(): void {
  indexCache = null;
  indexLoadedAt = 0;
}

async function loadIndex(db: Db): Promise<IndexEntry[]> {
  const docs = await db
    .collection(COLLECTION)
    .find(
      { embedding: { $exists: true, $ne: [] } },
      {
        projection: {
          id: 1,
          embedding: 1,
          qualityScore: 1,
          category: 1,
          type: 1,
          name: 1,
          allergens: 1,
          // projected only to compute ingredient-count for the junk filter; not kept in the index.
          'ingredients.name': 1,
        },
      },
    )
    .toArray();

  const entries: IndexEntry[] = [];
  let dropped = 0;
  for (const d of docs) {
    const name = String(d.name ?? '');
    const ingredientNames = (Array.isArray(d.ingredients) ? d.ingredients : [])
      .map((i: { name?: unknown }) => (typeof i?.name === 'string' ? i.name : ''))
      .filter(Boolean);
    if (isJunkEntry(name, ingredientNames)) {
      dropped += 1;
      continue;
    }
    entries.push({
      id: String(d.id),
      embedding: (d.embedding as number[]) ?? [],
      qualityScore: typeof d.qualityScore === 'number' ? d.qualityScore : 0.7,
      category: String(d.category ?? ''),
      type: String(d.type ?? ''),
      name,
      allergens: Array.isArray(d.allergens) ? (d.allergens as string[]) : [],
    });
  }
  if (dropped > 0) {
    // eslint-disable-next-line no-console
    console.log(`[recipe-library] index loaded: ${entries.length} entries (${dropped} junk filtered)`);
  }
  return entries;
}

async function getIndex(db: Db): Promise<IndexEntry[]> {
  const fresh = indexCache && Date.now() - indexLoadedAt < INDEX_TTL_MS;
  if (fresh) return indexCache as IndexEntry[];
  if (indexLoading) return indexLoading;

  indexLoading = loadIndex(db)
    .then((idx) => {
      indexCache = idx;
      indexLoadedAt = Date.now();
      return idx;
    })
    .finally(() => {
      indexLoading = null;
    });
  return indexLoading;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Shared candidate predicate so vector + lexical legs see the same universe. */
function passesFilter(entry: IndexEntry, opts: RecipeSearchOptions, exclude: Set<string>): boolean {
  if (opts.category && entry.category !== opts.category) return false;
  if (opts.type && entry.type !== opts.type) return false;
  if (exclude.size > 0) {
    for (const a of entry.allergens) if (exclude.has(a.toLowerCase())) return false;
  }
  return true;
}

/** Reciprocal Rank Fusion: combine ranked id lists into a single score map. */
function rrf(lists: string[][]): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return fused;
}

/**
 * Hybrid search over the chef's personal recipe library.
 */
export async function search(
  query: string,
  opts: RecipeSearchOptions = {},
): Promise<RecipeSearchHit[]> {
  const limit = Math.max(1, opts.limit ?? 6);
  const db = await getDb();
  const index = await getIndex(db);
  if (index.length === 0) return [];

  const exclude = new Set((opts.dietaryExclude ?? []).map((a) => a.toLowerCase()));
  const candidates = index.filter((e) => passesFilter(e, opts, exclude));
  if (candidates.length === 0) return [];

  // ── Vector leg ──
  let vectorRanked: string[] = [];
  let vectorLegRan = false;
  const cosineById = new Map<string, number>();
  try {
    const qVec = await generateEmbedding(query);
    vectorLegRan = true;
    const scored = candidates.map((e) => {
      const score = cosineSimilarity(qVec, e.embedding);
      cosineById.set(e.id, score);
      return { id: e.id, score };
    });
    vectorRanked = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, VECTOR_LEG_N)
      .map((x) => x.id);
  } catch {
    // Embedder down — degrade to lexical-only (relevance floor is skipped below).
  }

  // ── Lexical leg (Mongo $text on the same candidate filter) ──
  const candidateIds = new Set(candidates.map((c) => c.id));
  let lexicalRanked: string[] = [];
  try {
    const mongoFilter: Record<string, unknown> = {
      $text: { $search: query },
      id: { $in: [...candidateIds] },
    };
    const lexDocs = await db
      .collection(COLLECTION)
      .find(mongoFilter, { projection: { id: 1, score: { $meta: 'textScore' } } })
      .sort({ score: { $meta: 'textScore' } })
      .limit(LEXICAL_LEG_N)
      .toArray();
    lexicalRanked = lexDocs.map((d) => String(d.id));
  } catch {
    // $text index missing or query unsupported — vector leg still carries.
  }

  if (vectorRanked.length === 0 && lexicalRanked.length === 0) return [];

  // ── Fuse + rerank ──
  const fused = rrf([vectorRanked, lexicalRanked]);
  const qById = new Map(candidates.map((c) => [c.id, c]));

  const ranked = [...fused.entries()]
    .map(([id, rrfScore]) => {
      const entry = qById.get(id);
      const quality = entry?.qualityScore ?? 0.7;
      let score = rrfScore * quality;
      // Stage boost: components at the recipe stage, dishes at the menu stage.
      if (opts.stage === 'recipe' && entry?.type === 'component') score *= 1.15;
      if (opts.stage === 'menu' && entry?.type === 'dish') score *= 1.15;
      return { id, score };
    })
    .sort((a, b) => b.score - a.score);

  // ── Relevance floor + dedup near-identical names (keep highest-scored) ──
  // The floor drops weak/off-brief matches so the agent never treats junk as the
  // chef's canonical ratios. Applied only when the vector leg ran — every candidate
  // has a cosine (we scored all, not just the top-40), so even lexical-only hits are
  // gated. If the embedder was down, we skip the floor and degrade to lexical recall.
  const seenNames = new Set<string>();
  const finalIds: Array<{ id: string; score: number }> = [];
  for (const r of ranked) {
    if (vectorLegRan && (cosineById.get(r.id) ?? 0) < RELEVANCE_FLOOR) continue;
    const entry = qById.get(r.id);
    const key = entry ? normalizeName(entry.name) : r.id;
    if (key && seenNames.has(key)) continue;
    if (key) seenNames.add(key);
    finalIds.push(r);
    if (finalIds.length >= limit) break;
  }
  if (finalIds.length === 0) return [];

  // ── Hydrate full records from Mongo, preserve ranking order ──
  const fullDocs = await db
    .collection(COLLECTION)
    .find(
      { id: { $in: finalIds.map((f) => f.id) } },
      {
        projection: {
          id: 1,
          name: 1,
          category: 1,
          type: 1,
          usage: 1,
          summary: 1,
          ingredients: 1,
          techniques: 1,
          provenance: 1,
        },
      },
    )
    .toArray();
  const docById = new Map(fullDocs.map((d) => [String(d.id), d]));

  return finalIds
    .map(({ id, score }) => {
      const d = docById.get(id);
      if (!d) return null;
      return {
        id,
        name: String(d.name ?? ''),
        category: String(d.category ?? ''),
        type: String(d.type ?? ''),
        usage: String(d.usage ?? 'adapt'),
        summary: (d.summary as string | null) ?? null,
        ingredients: Array.isArray(d.ingredients) ? (d.ingredients as RecipeSearchHit['ingredients']) : [],
        techniques: Array.isArray(d.techniques) ? (d.techniques as string[]) : [],
        provenance: (d.provenance as Record<string, unknown> | null) ?? null,
        score: Math.round(score * 1e6) / 1e6,
      } satisfies RecipeSearchHit;
    })
    .filter((x): x is RecipeSearchHit => x !== null);
}
