/**
 * FlavorDB pairing scorer — quantitative, cuisine-aware, decision-support.
 *
 * Reference chemistry lives in `chef_flavor_ingredients` / `chef_flavor_molecules`
 * (loaded once by scripts/load-flavordb.ts; embeddings PERSISTED, never recomputed at
 * boot). This service reads them into a lazy module-level in-memory index and does all
 * scoring as PURE SET MATH — no LLM per query. The local bge-m3 embedder is only used
 * once, to resolve an unmatched chef ingredient name to a FlavorDB entity; that match is
 * then cached in `chef_flavor_aliases` by scripts/build-flavor-aliases.ts.
 *
 * Design (per ideas/molecules_pairing.md):
 *  - Decision-support, not oracle: scores FLAG/EXPLAIN; the model + domain.md decide.
 *  - Cuisine-aware: Western rewards HIGH shared-compound overlap (complementary);
 *    East-Asian rewards LOW overlap (contrasting, per Ahn et al. 2011). Unknown → no side.
 *  - Graceful fallback: unresolved ingredient → { matched:false } so the model falls back
 *    to qualitative rules; never emit a false-confident zero.
 */
import type { Db } from 'mongodb';

import { getDb } from './db.js';
import { normalizeIngredientNames, type NormalizedIngredient } from './ingredient-normalizer.js';
import { cosineSimilarity, generateEmbedding } from '../../lib/embedder.js';

const INGREDIENTS_COLLECTION = 'chef_flavor_ingredients';
const ALIASES_COLLECTION = 'chef_flavor_aliases';
const INDEX_TTL_MS = 30 * 60 * 1000;

/** Embedding cosine floor for accepting a cross-lingual (PL↔EN) name match. */
export const MATCH_THRESHOLD = 0.62;

export type CuisineAxis = 'complementary' | 'contrasting' | 'unknown';
export type Verdict = 'strong' | 'moderate' | 'weak' | 'unknown';

// Jaccard thresholds. For complementary (Western) HIGH overlap is good; for contrasting
// (East-Asian) LOW overlap is good (thresholds flipped). Exact cutoffs are heuristic —
// the eval harness validates RANKING (good > anti), which is monotone in overlap.
const COMP_STRONG = 0.15;
const COMP_MODERATE = 0.07;
const CONTRAST_STRONG = 0.03;
const CONTRAST_MODERATE = 0.08;

// ── In-memory index ──
interface FlavorEntry {
  entityId: number;
  name: string;
  synonyms: string[];
  scientificName: string;
  category: string;
  moleculeIds: number[];
  moleculeSet: Set<number>;
  descriptors: string[];
  nameEmbedding: number[];
}

interface FlavorIndex {
  entries: FlavorEntry[];
  byEntityId: Map<number, FlavorEntry>;
  /** normalized exact name / synonym → entityId */
  exactName: Map<string, number>;
  /** normalized chefName → entityId | null (null = known-unresolved) */
  aliasCache: Map<string, number | null>;
  /**
   * Per-index memo of resolveIngredient results. The embed fallback is an HTTP
   * roundtrip to the local embedder plus a 935-entity cosine scan; the pairwise
   * audit asks for the same name up to 2·(n−1) times, so without this an
   * unresolved palette entry is re-embedded a dozen times per menu.
   */
  resolveMemo: Map<string, ResolveResult>;
}

let indexCache: FlavorIndex | null = null;
let indexLoadedAt = 0;
let indexLoading: Promise<FlavorIndex> | null = null;

export function invalidateFlavorIndex(): void {
  indexCache = null;
  indexLoadedAt = 0;
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    // ł/đ/ø do NOT decompose under NFD — map explicitly so Polish words survive
    // (otherwise "tłuszcz"→"t uszcz", "żółtka"→"zo tka", "bułki"→"bu ki").
    .replace(/ł/g, 'l')
    .replace(/đ/g, 'd')
    .replace(/ø/g, 'o')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function loadIndex(db: Db): Promise<FlavorIndex> {
  const docs = await db
    .collection(INGREDIENTS_COLLECTION)
    .find(
      {},
      {
        projection: {
          entityId: 1,
          name: 1,
          synonyms: 1,
          scientificName: 1,
          category: 1,
          moleculeIds: 1,
          descriptors: 1,
          nameEmbedding: 1,
        },
      },
    )
    .toArray();

  const entries: FlavorEntry[] = [];
  const byEntityId = new Map<number, FlavorEntry>();
  const exactName = new Map<string, number>();

  for (const d of docs) {
    const moleculeIds = Array.isArray(d.moleculeIds) ? (d.moleculeIds as number[]) : [];
    const entry: FlavorEntry = {
      entityId: Number(d.entityId),
      name: String(d.name ?? ''),
      synonyms: Array.isArray(d.synonyms) ? (d.synonyms as string[]) : [],
      scientificName: String(d.scientificName ?? ''),
      category: String(d.category ?? ''),
      moleculeIds,
      moleculeSet: new Set(moleculeIds),
      descriptors: Array.isArray(d.descriptors) ? (d.descriptors as string[]) : [],
      nameEmbedding: Array.isArray(d.nameEmbedding) ? (d.nameEmbedding as number[]) : [],
    };
    entries.push(entry);
    byEntityId.set(entry.entityId, entry);
    for (const n of [entry.name, ...entry.synonyms]) {
      const key = normalizeName(n);
      if (key && !exactName.has(key)) exactName.set(key, entry.entityId);
    }
  }

  const aliasCache = new Map<string, number | null>();
  try {
    const aliasDocs = await db
      .collection(ALIASES_COLLECTION)
      .find({}, { projection: { chefName: 1, entityId: 1 } })
      .toArray();
    for (const a of aliasDocs) {
      const key = normalizeName(String(a.chefName ?? ''));
      if (!key) continue;
      const eid = a.entityId;
      aliasCache.set(key, typeof eid === 'number' ? eid : null);
    }
  } catch {
    // aliases not built yet — exact + embed fallback still work.
  }

  return { entries, byEntityId, exactName, aliasCache, resolveMemo: new Map() };
}

async function getIndex(): Promise<FlavorIndex> {
  const fresh = indexCache && Date.now() - indexLoadedAt < INDEX_TTL_MS;
  if (fresh) return indexCache as FlavorIndex;
  if (indexLoading) return indexLoading;
  const db = await getDb();
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

export interface ResolveResult {
  matched: boolean;
  entityId: number | null;
  score: number;
  method: 'alias' | 'exact' | 'embed' | 'none';
  name?: string;
}

/**
 * Resolve a (possibly Polish) ingredient name to a FlavorDB entity.
 * alias cache → exact name/synonym → bge-m3 cosine fallback (≥ MATCH_THRESHOLD).
 */
export async function resolveIngredient(
  rawName: string,
  opts: { skipAliasCache?: boolean } = {},
): Promise<ResolveResult> {
  const idx = await getIndex();
  const key = normalizeName(rawName);
  if (!key) return { matched: false, entityId: null, score: 0, method: 'none' };

  // 0. in-process memo. Bypassed with the alias cache so the alias BUILDER always
  //    re-resolves from scratch; a memo hit is byte-identical to a recomputation.
  const memoized = opts.skipAliasCache ? undefined : idx.resolveMemo.get(key);
  if (memoized) return memoized;
  const remember = (result: ResolveResult): ResolveResult => {
    if (!opts.skipAliasCache) idx.resolveMemo.set(key, result);
    return result;
  };

  // 1. alias cache (may be a known-unresolved null). Skipped when (re)building aliases.
  if (!opts.skipAliasCache && idx.aliasCache.has(key)) {
    const eid = idx.aliasCache.get(key) ?? null;
    if (eid === null) return remember({ matched: false, entityId: null, score: 0, method: 'alias' });
    const entry = idx.byEntityId.get(eid);
    return remember({ matched: true, entityId: eid, score: 1, method: 'alias', name: entry?.name });
  }

  // 2. exact name / synonym
  const exact = idx.exactName.get(key);
  if (exact !== undefined) {
    const entry = idx.byEntityId.get(exact);
    return remember({ matched: true, entityId: exact, score: 1, method: 'exact', name: entry?.name });
  }

  // 3. embed fallback (cross-lingual). Cached afterward by build-flavor-aliases.ts.
  try {
    const qVec = await generateEmbedding(rawName);
    let best: FlavorEntry | null = null;
    let bestScore = -1;
    for (const e of idx.entries) {
      if (e.nameEmbedding.length === 0) continue;
      const s = cosineSimilarity(qVec, e.nameEmbedding);
      if (s > bestScore) {
        bestScore = s;
        best = e;
      }
    }
    if (best && bestScore >= MATCH_THRESHOLD) {
      return remember({ matched: true, entityId: best.entityId, score: bestScore, method: 'embed', name: best.name });
    }
    return remember({ matched: false, entityId: null, score: bestScore, method: 'none' });
  } catch {
    // Embedder down — do NOT memoize; a transient outage must not pin this name
    // to "unresolved" for the lifetime of the index.
    return { matched: false, entityId: null, score: 0, method: 'none' };
  }
}

export interface PaletteEntry {
  /** The surface form handed to the resolver — a normalized base-form name. */
  name: string;
  /** The raw `ingredients.name` string it was derived from. */
  raw: string;
  /** Resolved FlavorDB entity, or null when the name is genuinely unknown to FlavorDB. */
  entityId: number | null;
}

/**
 * Build the candidate palette for a menu-level audit from raw recipe-library
 * ingredient strings.
 *
 * Two things happen here that a plain `[...new Set(names)]` cannot do:
 *  1. the pure normalizer strips quantities/units/preparation, splits 'X lub Y',
 *     and drops non-ingredients (cuisine labels, yield/copyright rows, prose);
 *  2. where a name has both a specific and a generic form ('kiełbasa krakowska'
 *     → 'kiełbasa'), the FIRST FORM THAT RESOLVES wins — a lookup, not a guess.
 *
 * Unresolved ingredients are deliberately KEPT in the palette. Filtering them out
 * would drive `coverage` to 1.0 while telling the model less than before; the
 * point of the metric is to report what FlavorDB does not know.
 */
export async function buildFlavorPalette(
  rawNames: string[],
  limit = 14,
): Promise<PaletteEntry[]> {
  const normalized = normalizeIngredientNames(rawNames);
  const palette: PaletteEntry[] = [];
  const seenNames = new Set<string>();
  const seenEntities = new Set<number>();

  const add = async (raw: string, candidates: string[]): Promise<boolean> => {
    if (candidates.length === 0 || palette.length >= limit) return false;
    let chosen: PaletteEntry = { name: candidates[0], raw, entityId: null };
    for (const candidate of candidates) {
      const res = await resolveIngredient(candidate);
      if (res.matched && res.entityId !== null) {
        chosen = { name: candidate, raw, entityId: res.entityId };
        break;
      }
    }
    if (seenNames.has(chosen.name)) return false;
    // Two spellings of one ingredient ('cebula' / 'cebuli') would otherwise burn
    // two palette slots and produce a meaningless self-pairing.
    if (chosen.entityId !== null && seenEntities.has(chosen.entityId)) return false;
    seenNames.add(chosen.name);
    if (chosen.entityId !== null) seenEntities.add(chosen.entityId);
    palette.push(chosen);
    return true;
  };

  // Primary names first, so substitutes and secondary list items ('X lub Y',
  // 'sól i pieprz') only ever fill leftover slots and never crowd out the
  // ingredient a recipe actually leads with.
  for (const entry of normalized) {
    if (palette.length >= limit) break;
    await add(entry.raw, entry.candidates);
  }
  for (const entry of normalized) {
    for (const alternative of entry.alternatives) {
      if (palette.length >= limit) break;
      // Each alternative is its own ingredient, not a fallback for the previous.
      await add(entry.raw, [alternative]);
    }
  }

  return palette;
}

export type { NormalizedIngredient };

export interface IngredientProfile {
  matched: boolean;
  name: string;
  entityId: number | null;
  compounds: number[];
  descriptors: string[];
  category: string;
  score: number;
  method: ResolveResult['method'];
}

export async function getIngredientProfile(name: string): Promise<IngredientProfile> {
  const res = await resolveIngredient(name);
  if (!res.matched || res.entityId === null) {
    return {
      matched: false,
      name,
      entityId: null,
      compounds: [],
      descriptors: [],
      category: '',
      score: res.score,
      method: res.method,
    };
  }
  const idx = await getIndex();
  const entry = idx.byEntityId.get(res.entityId);
  return {
    matched: true,
    name,
    entityId: res.entityId,
    compounds: entry?.moleculeIds ?? [],
    descriptors: entry?.descriptors ?? [],
    category: entry?.category ?? '',
    score: res.score,
    method: res.method,
  };
}

// ── Cuisine classification ──
const WESTERN_RE = /(wlos|włos|ital|francus|french|hiszpa|spanish|śródziem|srodziem|mediterran|europ|amery|americ|nordy|nordic|skandyn|nemieck|german|polsk|polish)/i;
const EAST_ASIAN_RE = /(japo|japan|chin|kore|taj|thai|wietnam|vietnam|azja|azjat|asian|india|hindus|indon)/i;

export function cuisineAxis(cuisine?: string | string[]): CuisineAxis {
  if (!cuisine) return 'unknown';
  const text = (Array.isArray(cuisine) ? cuisine.join(' ') : cuisine).toLowerCase();
  if (!text.trim()) return 'unknown';
  const east = EAST_ASIAN_RE.test(text);
  const west = WESTERN_RE.test(text);
  if (east && !west) return 'contrasting';
  if (west && !east) return 'complementary';
  return 'unknown';
}

export interface PairingScore {
  matched: boolean;
  a: string;
  b: string;
  shared: number;
  jaccard: number;
  sharedDescriptors: string[];
  verdict: Verdict;
  axis: CuisineAxis;
  rationale: string;
}

function intersectCount(a: Set<number>, b: Set<number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const x of small) if (large.has(x)) n++;
  return n;
}

function verdictFor(axis: CuisineAxis, jaccard: number): Verdict {
  if (axis === 'contrasting') {
    if (jaccard <= CONTRAST_STRONG) return 'strong';
    if (jaccard <= CONTRAST_MODERATE) return 'moderate';
    return 'weak';
  }
  // complementary OR unknown → reward overlap (unknown reports it without taking a side)
  if (jaccard >= COMP_STRONG) return 'strong';
  if (jaccard >= COMP_MODERATE) return 'moderate';
  return 'weak';
}

/**
 * Score a pairing as shared-compound overlap, cuisine-aware.
 * Returns { matched:false } if either ingredient can't be resolved.
 */
export async function scorePairing(
  a: string,
  b: string,
  opts: { cuisine?: string | string[] } = {},
): Promise<PairingScore> {
  const axis = cuisineAxis(opts.cuisine);
  const [pa, pb] = await Promise.all([resolveIngredient(a), resolveIngredient(b)]);

  if (!pa.matched || !pb.matched || pa.entityId === null || pb.entityId === null) {
    const unresolved = [!pa.matched ? a : null, !pb.matched ? b : null].filter(Boolean).join(', ');
    return {
      matched: false,
      a,
      b,
      shared: 0,
      jaccard: 0,
      sharedDescriptors: [],
      verdict: 'unknown',
      axis,
      rationale: `No FlavorDB data for: ${unresolved}. Assess qualitatively according to domain.md (complementary/contrast/bridge).`,
    };
  }

  const idx = await getIndex();
  const ea = idx.byEntityId.get(pa.entityId)!;
  const eb = idx.byEntityId.get(pb.entityId)!;
  const shared = intersectCount(ea.moleculeSet, eb.moleculeSet);
  const unionSize = ea.moleculeSet.size + eb.moleculeSet.size - shared;
  const jaccard = unionSize > 0 ? shared / unionSize : 0;
  const sharedDescriptors = ea.descriptors.filter((d) => eb.descriptors.includes(d)).slice(0, 12);
  const verdict = verdictFor(axis, jaccard);

  const overlapNote = `${shared} shared compounds (jaccard ${jaccard.toFixed(3)})`;
  const descNote = sharedDescriptors.length
    ? `; shared notes: ${sharedDescriptors.slice(0, 6).join(', ')}`
    : '';
  let axisNote: string;
  if (axis === 'complementary') {
    axisNote = ' — Western cuisine rewards high overlap (complementarity).';
  } else if (axis === 'contrasting') {
    axisNote = ' — East Asian cuisine rewards LOW overlap (contrast, Ahn 2011).';
  } else {
    axisNote = ' — unspecified cuisine: reporting overlap without direction evaluation.';
  }
  const rationale = `${ea.name} + ${eb.name}: ${overlapNote}${descNote}${axisNote}`;

  return { matched: true, a, b, shared, jaccard, sharedDescriptors, verdict, axis, rationale };
}

export interface BridgeSuggestion {
  name: string;
  entityId: number;
  sharedWithA: number;
  sharedWithB: number;
  bridgeScore: number;
  descriptors: string[];
}

/**
 * Top-k third ingredients maximizing shared(a,x)+shared(x,b) — the bridging rule,
 * now computed instead of guessed.
 */
export async function suggestBridges(
  a: string,
  b: string,
  limit = 5,
): Promise<{ matched: boolean; bridges: BridgeSuggestion[] }> {
  const [pa, pb] = await Promise.all([resolveIngredient(a), resolveIngredient(b)]);
  if (!pa.matched || !pb.matched || pa.entityId === null || pb.entityId === null) {
    return { matched: false, bridges: [] };
  }
  const idx = await getIndex();
  const ea = idx.byEntityId.get(pa.entityId)!;
  const eb = idx.byEntityId.get(pb.entityId)!;

  const scored: BridgeSuggestion[] = [];
  for (const e of idx.entries) {
    if (e.entityId === ea.entityId || e.entityId === eb.entityId) continue;
    if (e.moleculeSet.size === 0) continue;
    const sa = intersectCount(e.moleculeSet, ea.moleculeSet);
    const sb = intersectCount(e.moleculeSet, eb.moleculeSet);
    if (sa === 0 || sb === 0) continue; // a real bridge must touch both
    scored.push({
      name: e.name,
      entityId: e.entityId,
      sharedWithA: sa,
      sharedWithB: sb,
      bridgeScore: sa + sb,
      descriptors: e.descriptors.slice(0, 8),
    });
  }
  scored.sort((x, y) => y.bridgeScore - x.bridgeScore);
  return { matched: true, bridges: scored.slice(0, Math.max(1, limit)) };
}

export interface PartnerSuggestion {
  name: string;
  entityId: number;
  shared: number;
  jaccard: number;
  sharedDescriptors: string[];
}

/**
 * Rank FlavorDB ingredients as partners for a single ingredient, cuisine-aware.
 * complementary/unknown → highest shared-compound overlap; contrasting → lowest
 * overlap that is still > 0 (a contrast that shares *some* anchor, per Ahn 2011).
 */
export async function suggestPartners(
  ingredient: string,
  opts: { cuisine?: string | string[]; limit?: number } = {},
): Promise<{ matched: boolean; axis: CuisineAxis; partners: PartnerSuggestion[] }> {
  const axis = cuisineAxis(opts.cuisine);
  const limit = Math.max(1, opts.limit ?? 8);
  const res = await resolveIngredient(ingredient);
  if (!res.matched || res.entityId === null) return { matched: false, axis, partners: [] };

  const idx = await getIndex();
  const base = idx.byEntityId.get(res.entityId)!;
  const scored: Array<PartnerSuggestion & { _j: number }> = [];
  for (const e of idx.entries) {
    if (e.entityId === base.entityId || e.moleculeSet.size === 0) continue;
    const shared = intersectCount(base.moleculeSet, e.moleculeSet);
    if (shared === 0) continue;
    const unionSize = base.moleculeSet.size + e.moleculeSet.size - shared;
    const jaccard = unionSize > 0 ? shared / unionSize : 0;
    scored.push({
      name: e.name,
      entityId: e.entityId,
      shared,
      jaccard: Math.round(jaccard * 1000) / 1000,
      sharedDescriptors: base.descriptors.filter((d) => e.descriptors.includes(d)).slice(0, 6),
      _j: jaccard,
    });
  }
  // contrasting → ascending overlap (lowest first); else descending (highest first).
  scored.sort((x, y) => (axis === 'contrasting' ? x._j - y._j : y._j - x._j));
  return {
    matched: true,
    axis,
    partners: scored.slice(0, limit).map(({ _j, ...rest }) => rest),
  };
}

export interface MenuFlavorProfile {
  coverage: number;
  resolved: number;
  total: number;
  dominantDescriptors: Array<{ descriptor: string; count: number }>;
  compoundCount: number;
  balanceFlags: string[];
}

/**
 * Aggregate descriptor/compound profile for a set of ingredients (a dish or menu).
 * Detects monotony (one dominant aroma family across the set).
 */
export async function profileForIngredients(names: string[]): Promise<MenuFlavorProfile> {
  const profiles = await Promise.all(names.map((n) => getIngredientProfile(n)));
  const resolved = profiles.filter((p) => p.matched);
  const total = names.length || 1;

  const descHist = new Map<string, number>();
  const compounds = new Set<number>();
  for (const p of resolved) {
    for (const d of p.descriptors) descHist.set(d, (descHist.get(d) ?? 0) + 1);
    for (const c of p.compounds) compounds.add(c);
  }
  const dominantDescriptors = [...descHist.entries()]
    .map(([descriptor, count]) => ({ descriptor, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const balanceFlags: string[] = [];
  const coverage = resolved.length / total;
  if (coverage < 0.5) {
    balanceFlags.push(`low FlavorDB coverage (${resolved.length}/${total}) — assess qualitatively`);
  }
  if (resolved.length >= 3 && dominantDescriptors[0]) {
    const top = dominantDescriptors[0];
    if (top.count >= Math.ceil(resolved.length * 0.75)) {
      balanceFlags.push(
        `aroma monotony: "${top.descriptor}" dominates in ${top.count}/${resolved.length} ingredients — consider contrast`,
      );
    }
  }

  return {
    coverage: Math.round(coverage * 1000) / 1000,
    resolved: resolved.length,
    total: names.length,
    dominantDescriptors,
    compoundCount: compounds.size,
    balanceFlags,
  };
}
